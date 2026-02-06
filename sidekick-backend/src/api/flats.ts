import type { FastifyInstance, FastifyRequest } from 'fastify';
import { prisma } from '../db/client.js';
import type { FlatMapOrigin } from '../models/FlatMap.js';

/**
 * User type for authenticated requests
 */
interface AuthenticatedUser {
  userId: string;
  email: string;
}

/**
 * Helper to get authenticated user from request
 * The authenticate decorator sets request.user, but TypeScript doesn't know the type
 */
function getAuthenticatedUser(request: FastifyRequest): AuthenticatedUser | null {
  const user = (request as any).user;
  if (user && typeof user === 'object' && 'userId' in user && 'email' in user) {
    return user as AuthenticatedUser;
  }
  return null;
}

/**
 * Authenticated request type
 */
type AuthenticatedRequest = FastifyRequest;

/**
 * Create flat request body
 */
interface CreateFlatBody {
  name: string;
  origin: {
    description: string;
    compassHeading: number;
  };
}

/**
 * Update flat request body
 */
interface UpdateFlatBody {
  name?: string;
  origin?: {
    description: string;
    compassHeading: number;
  };
}

/**
 * Query parameters for list endpoint
 */
interface ListQuery {
  limit?: number;
  offset?: number;
}

/**
 * Verify flat ownership and return flat
 * 
 * @param flatId - Flat ID
 * @param userId - User ID
 * @returns Flat map if found and owned
 * @throws Error with appropriate status code
 */
async function verifyFlatOwnership(
  flatId: string,
  userId: string
): Promise<{
  id: string;
  userId: string;
  name: string;
  origin: string;
  createdAt: Date;
  updatedAt: Date;
}> {
  const flat = await prisma.flatMap.findUnique({
    where: { id: flatId },
  });

  if (!flat) {
    const error: any = new Error('Flat not found');
    error.statusCode = 404;
    throw error;
  }

  if (flat.userId !== userId) {
    const error: any = new Error('Flat does not belong to user');
    error.statusCode = 403;
    throw error;
  }

  return flat;
}

/**
 * Flat maps CRUD routes plugin
 * 
 * Handles creation, reading, updating, and deletion of flat maps.
 * All endpoints require authentication.
 * 
 * @param fastify - Fastify instance
 */
export default async function flatRoutes(fastify: FastifyInstance) {
  /**
   * GET /flats
   * List all flats owned by the authenticated user
   */
  fastify.get<{ Querystring: ListQuery }>(
    '/',
    {
      preHandler: [(fastify as any).authenticate],
    },
    async (request: AuthenticatedRequest, reply) => {
      const authUser = getAuthenticatedUser(request);
      if (!authUser) {
        return reply.code(401).send({
          error: 'unauthorized',
          message: 'Not authenticated',
        });
      }
      const query = request.query as { limit?: number; offset?: number };
      const limit = Math.min(query.limit || 20, 100);
      const offset = query.offset || 0;

      try {
        // Get flats with room count
        const [flats, total] = await Promise.all([
          prisma.flatMap.findMany({
            where: { userId: authUser.userId },
            take: limit,
            skip: offset,
            orderBy: { updatedAt: 'desc' },
            include: {
              _count: {
                select: { rooms: true },
              },
            },
          }),
          prisma.flatMap.count({
            where: { userId: authUser.userId },
          }),
        ]);

        request.log.info(`[Flats] Listed ${flats.length} flats for user ${authUser.userId}`);

        return reply.send({
          flats: flats.map((flat: any) => ({
            id: flat.id,
            name: flat.name,
            roomCount: flat._count.rooms,
            createdAt: flat.createdAt.toISOString(),
            updatedAt: flat.updatedAt.toISOString(),
          })),
          total,
        });
      } catch (error) {
        request.log.error({ err: error }, '[Flats] List error');
        return reply.code(500).send({
          error: 'internal_error',
          message: 'Failed to list flats',
        });
      }
    }
  );

  /**
   * POST /flats
   * Create a new flat map
   */
  fastify.post<{ Body: CreateFlatBody }>(
    '/',
    {
      preHandler: [(fastify as any).authenticate],
    },
    async (request: AuthenticatedRequest, reply) => {
      const authUser = getAuthenticatedUser(request);
      console.log('authUser:', authUser);
      if (!authUser) {
        return reply.code(401).send({
          error: 'unauthorized',
          message: 'Not authenticated',
        });
      }

      const { name, origin } = request.body as CreateFlatBody;

      // Validation
      if (!name || name.trim().length === 0) {
        return reply.code(400).send({
          error: 'validation_error',
          message: 'Name is required and cannot be empty',
        });
      }

      if (!origin || !origin.description || origin.compassHeading === undefined) {
        return reply.code(400).send({
          error: 'validation_error',
          message: 'Origin with description and compassHeading is required',
        });
      }

      if (origin.compassHeading < 0 || origin.compassHeading > 360) {
        return reply.code(400).send({
          error: 'validation_error',
          message: 'compassHeading must be between 0 and 360',
        });
      }

      try {
        // Create flat  
        const flat = await prisma.flatMap.create({
          data: {
            userId: authUser.userId,
            name: name.trim(),
            origin: JSON.stringify(origin),
          },
        });

        // Parse origin for response
        const originParsed: FlatMapOrigin = JSON.parse(flat.origin);

        request.log.info(`[Flats] Created flat: ${flat.id} for user ${authUser.userId}`);

        return reply.code(201).send({
          id: flat.id,
          name: flat.name,
          origin: originParsed,
          createdAt: flat.createdAt.toISOString(),
        });
      } catch (error) {
        request.log.error({ err: error }, '[Flats] Create error');
        return reply.code(500).send({
          error: 'internal_error',
          message: 'Failed to create flat',
        });
      }
    }
  );

  /**
   * GET /flats/:flatId
   * Get a flat with all its rooms, doorways, and landmarks
   */
  fastify.get<{ Params: { flatId: string } }>(
    '/:flatId',
    {
      preHandler: [(fastify as any).authenticate],
    },
    async (request: AuthenticatedRequest, reply) => {
      const authUser = getAuthenticatedUser(request);
      if (!authUser) {
        return reply.code(401).send({
          error: 'unauthorized',
          message: 'Not authenticated',
        });
      }

      const { flatId } = request.params as { flatId: string };

      try {
        // Verify ownership
        await verifyFlatOwnership(flatId, authUser.userId);

        // Get flat with all relations
        const flat = await prisma.flatMap.findUnique({
          where: { id: flatId },
          include: {
            rooms: {
              include: {
                doorways: {
                  include: {
                    toRoom: {
                      select: {
                        id: true,
                        name: true,
                      },
                    },
                  },
                },
                incomingDoorways: {
                  include: {
                    fromRoom: {
                      select: {
                        id: true,
                        name: true,
                      },
                    },
                  },
                },
                landmarks: true,
                referenceImages: {
                  select: {
                    id: true,
                    locationTag: true,
                    compassHeading: true,
                    description: true,
                    capturedAt: true,
                    // Don't include imageData in list
                  },
                },
              },
            },
          },
        });

        if (!flat) {
          return reply.code(404).send({
            error: 'not_found',
            message: 'Flat not found',
          });
        }

        // Parse origin
        const originParsed: FlatMapOrigin = JSON.parse(flat.origin);

        request.log.info(`[Flats] Retrieved flat: ${flatId}`);

        return reply.send({
          id: flat.id,
          name: flat.name,
          origin: originParsed,
          rooms: flat.rooms.map((room: any) => ({
            id: room.id,
            type: room.type,
            name: room.name,
            positionX: room.positionX,
            positionY: room.positionY,
            doorways: room.doorways.map((doorway: any) => ({
              id: doorway.id,
              fromRoomId: doorway.fromRoomId,
              toRoomId: doorway.toRoomId,
              toRoom: doorway.toRoom,
              positionX: doorway.positionX,
              positionY: doorway.positionY,
              compassHeading: doorway.compassHeading,
              type: doorway.type,
              distanceSteps: doorway.distanceSteps,
            })),
            incomingDoorways: room.incomingDoorways.map((doorway: any) => ({
              id: doorway.id,
              fromRoomId: doorway.fromRoomId,
              toRoomId: doorway.toRoomId,
              fromRoom: doorway.fromRoom,
              positionX: doorway.positionX,
              positionY: doorway.positionY,
              compassHeading: doorway.compassHeading,
              type: doorway.type,
              distanceSteps: doorway.distanceSteps,
            })),
            landmarks: room.landmarks.map((landmark: any) => ({
              id: landmark.id,
              name: landmark.name,
              description: landmark.description,
              positionX: landmark.positionX,
              positionY: landmark.positionY,
              compassDirection: landmark.compassDirection,
            })),
            referenceImages: room.referenceImages,
          })),
          createdAt: flat.createdAt.toISOString(),
          updatedAt: flat.updatedAt.toISOString(),
        });
      } catch (error: any) {
        if (error.statusCode) {
          return reply.code(error.statusCode).send({
            error: error.statusCode === 403 ? 'forbidden' : 'not_found',
            message: error.message,
          });
        }

        request.log.error({ err: error }, '[Flats] Get error');
        return reply.code(500).send({
          error: 'internal_error',
          message: 'Failed to get flat',
        });
      }
    }
  );

  /**
   * PUT /flats/:flatId
   * Update flat details (name, origin)
   */
  fastify.put<{ Params: { flatId: string }; Body: UpdateFlatBody }>(
    '/:flatId',
    {
      preHandler: [(fastify as any).authenticate],
    },
    async (request: AuthenticatedRequest, reply) => {
      const authUser = getAuthenticatedUser(request);
      if (!authUser) {
        return reply.code(401).send({
          error: 'unauthorized',
          message: 'Not authenticated',
        });
      }

      const { flatId } = request.params as { flatId: string };
      const { name, origin } = request.body as UpdateFlatBody;

      try {
        // Verify ownership
        await verifyFlatOwnership(flatId, authUser.userId);

        // Build update data
        const updateData: any = {};

        if (name !== undefined) {
          if (name.trim().length === 0) {
            return reply.code(400).send({
              error: 'validation_error',
              message: 'Name cannot be empty',
            });
          }
          updateData.name = name.trim();
        }

        if (origin !== undefined) {
          if (!origin.description || origin.compassHeading === undefined) {
            return reply.code(400).send({
              error: 'validation_error',
              message: 'Origin must include description and compassHeading',
            });
          }

          if (origin.compassHeading < 0 || origin.compassHeading > 360) {
            return reply.code(400).send({
              error: 'validation_error',
              message: 'compassHeading must be between 0 and 360',
            });
          }

          updateData.origin = JSON.stringify(origin);
        }

        // Update flat
        const updatedFlat = await prisma.flatMap.update({
          where: { id: flatId },
          data: updateData,
        });

        // Parse origin for response
        const originParsed: FlatMapOrigin = JSON.parse(updatedFlat.origin);

        request.log.info(`[Flats] Updated flat: ${flatId}`);

        return reply.send({
          id: updatedFlat.id,
          name: updatedFlat.name,
          origin: originParsed,
          createdAt: updatedFlat.createdAt.toISOString(),
          updatedAt: updatedFlat.updatedAt.toISOString(),
        });
      } catch (error: any) {
        if (error.statusCode) {
          return reply.code(error.statusCode).send({
            error: error.statusCode === 403 ? 'forbidden' : 'not_found',
            message: error.message,
          });
        }

        request.log.error({ err: error }, '[Flats] Update error');
        return reply.code(500).send({
          error: 'internal_error',
          message: 'Failed to update flat',
        });
      }
    }
  );

  /**
   * DELETE /flats/:flatId
   * Delete a flat and all its rooms, images, etc.
   */
  fastify.delete<{ Params: { flatId: string } }>(
    '/:flatId',
    {
      preHandler: [(fastify as any).authenticate],
    },
    async (request: AuthenticatedRequest, reply) => {
      const authUser = getAuthenticatedUser(request);
      if (!authUser) {
        return reply.code(401).send({
          error: 'unauthorized',
          message: 'Not authenticated',
        });
      }

      const { flatId } = request.params as { flatId: string };

      try {
        // Verify ownership
        await verifyFlatOwnership(flatId, authUser.userId);

        // Delete flat (cascade will delete rooms, doorways, etc.)
        await prisma.flatMap.delete({
          where: { id: flatId },
        });

        request.log.info(`[Flats] Deleted flat: ${flatId}`);

        return reply.send({
          success: true,
        });
      } catch (error: any) {
        if (error.statusCode) {
          return reply.code(error.statusCode).send({
            error: error.statusCode === 403 ? 'forbidden' : 'not_found',
            message: error.message,
          });
        }

        request.log.error({ err: error }, '[Flats] Delete error');
        return reply.code(500).send({
          error: 'internal_error',
          message: 'Failed to delete flat',
        });
      }
    }
  );
}
