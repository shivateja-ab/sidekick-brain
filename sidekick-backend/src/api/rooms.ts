import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { prisma } from '../db/client';

/**
 * Authenticated request with user
 */
interface AuthenticatedRequest extends FastifyRequest {
  user?: {
    id: string;
    email: string;
  };
}

/**
 * Create room request body
 */
interface CreateRoomBody {
  type: string;
  name: string;
  positionX: number;
  positionY: number;
}

/**
 * Update room request body
 */
interface UpdateRoomBody {
  type?: string;
  name?: string;
  positionX?: number;
  positionY?: number;
}

/**
 * Create doorway request body
 */
interface CreateDoorwayBody {
  toRoomId: string;
  positionX: number;
  positionY: number;
  compassHeading: number;
  distanceSteps?: number;
  type?: string;
}

/**
 * Create landmark request body
 */
interface CreateLandmarkBody {
  name: string;
  description?: string;
  positionX: number;
  positionY: number;
  compassDirection?: number;
}

/**
 * Valid room types
 */
const VALID_ROOM_TYPES = [
  'bedroom',
  'bathroom',
  'kitchen',
  'living_room',
  'dining_room',
  'corridor',
  'hallway',
  'entrance',
  'lift_lobby',
  'stairwell',
  'office',
  'storage',
  'other',
];

/**
 * Verify flat ownership
 */
async function verifyFlatOwnership(flatId: string, userId: string): Promise<void> {
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
}

/**
 * Verify room ownership and return room
 */
async function verifyRoomOwnership(
  flatId: string,
  roomId: string,
  userId: string
): Promise<{
  id: string;
  flatMapId: string;
  type: string;
  name: string;
  positionX: number;
  positionY: number;
  createdAt: Date;
  updatedAt: Date;
}> {
  // First verify flat ownership
  await verifyFlatOwnership(flatId, userId);

  // Then verify room exists and belongs to flat
  const room = await prisma.room.findUnique({
    where: { id: roomId },
  });

  if (!room) {
    const error: any = new Error('Room not found');
    error.statusCode = 404;
    throw error;
  }

  if (room.flatMapId !== flatId) {
    const error: any = new Error('Room does not belong to this flat');
    error.statusCode = 403;
    throw error;
  }

  return room;
}

/**
 * Room management routes plugin
 * 
 * Handles CRUD operations for rooms, doorways, and landmarks.
 * All endpoints require authentication and are nested under /flats/:flatId/rooms
 * 
 * @param fastify - Fastify instance
 */
export default async function roomRoutes(fastify: FastifyInstance) {
  /**
   * GET /flats/:flatId/rooms
   * List all rooms in a flat
   */
  fastify.get<{ Params: { flatId: string } }>(
    '/',
    {
      preHandler: [fastify.authenticate],
    },
    async (request: AuthenticatedRequest, reply) => {
      if (!request.user) {
        return reply.code(401).send({
          error: 'unauthorized',
          message: 'Not authenticated',
        });
      }

      const { flatId } = request.params;

      try {
        // Verify flat ownership
        await verifyFlatOwnership(flatId, request.user.id);

        // Get rooms with counts
        const rooms = await prisma.room.findMany({
          where: { flatMapId: flatId },
          include: {
            _count: {
              select: {
                doorways: true,
                incomingDoorways: true,
                landmarks: true,
                referenceImages: true,
              },
            },
          },
          orderBy: { name: 'asc' },
        });

        request.log.info(`[Rooms] Listed ${rooms.length} rooms for flat ${flatId}`);

        return reply.send({
          rooms: rooms.map((room) => ({
            id: room.id,
            type: room.type,
            name: room.name,
            positionX: room.positionX,
            positionY: room.positionY,
            doorwayCount: room._count.doorways + room._count.incomingDoorways,
            landmarkCount: room._count.landmarks,
            imageCount: room._count.referenceImages,
          })),
        });
      } catch (error: any) {
        if (error.statusCode) {
          return reply.code(error.statusCode).send({
            error: error.statusCode === 403 ? 'forbidden' : 'not_found',
            message: error.message,
          });
        }

        request.log.error(`[Rooms] List error:`, error);
        return reply.code(500).send({
          error: 'internal_error',
          message: 'Failed to list rooms',
        });
      }
    }
  );

  /**
   * POST /flats/:flatId/rooms
   * Create a new room
   */
  fastify.post<{ Params: { flatId: string }; Body: CreateRoomBody }>(
    '/',
    {
      preHandler: [fastify.authenticate],
    },
    async (request: AuthenticatedRequest, reply) => {
      if (!request.user) {
        return reply.code(401).send({
          error: 'unauthorized',
          message: 'Not authenticated',
        });
      }

      const { flatId } = request.params;
      const { type, name, positionX, positionY } = request.body;

      // Validation
      if (!type || !name || positionX === undefined || positionY === undefined) {
        return reply.code(400).send({
          error: 'validation_error',
          message: 'type, name, positionX, and positionY are required',
        });
      }

      if (!VALID_ROOM_TYPES.includes(type)) {
        return reply.code(400).send({
          error: 'validation_error',
          message: `type must be one of: ${VALID_ROOM_TYPES.join(', ')}`,
        });
      }

      if (name.trim().length === 0) {
        return reply.code(400).send({
          error: 'validation_error',
          message: 'name cannot be empty',
        });
      }

      try {
        // Verify flat ownership
        await verifyFlatOwnership(flatId, request.user.id);

        // Create room
        const room = await prisma.room.create({
          data: {
            flatMapId: flatId,
            type,
            name: name.trim(),
            positionX,
            positionY,
          },
        });

        request.log.info(`[Rooms] Created room: ${room.id} in flat ${flatId}`);

        return reply.code(201).send({
          id: room.id,
          type: room.type,
          name: room.name,
          positionX: room.positionX,
          positionY: room.positionY,
          createdAt: room.createdAt.toISOString(),
        });
      } catch (error: any) {
        if (error.statusCode) {
          return reply.code(error.statusCode).send({
            error: error.statusCode === 403 ? 'forbidden' : 'not_found',
            message: error.message,
          });
        }

        request.log.error(`[Rooms] Create error:`, error);
        return reply.code(500).send({
          error: 'internal_error',
          message: 'Failed to create room',
        });
      }
    }
  );

  /**
   * GET /flats/:flatId/rooms/:roomId
   * Get room with all details
   */
  fastify.get<{ Params: { flatId: string; roomId: string } }>(
    '/:roomId',
    {
      preHandler: [fastify.authenticate],
    },
    async (request: AuthenticatedRequest, reply) => {
      if (!request.user) {
        return reply.code(401).send({
          error: 'unauthorized',
          message: 'Not authenticated',
        });
      }

      const { flatId, roomId } = request.params;

      try {
        // Verify room ownership
        await verifyRoomOwnership(flatId, roomId, request.user.id);

        // Get room with all relations
        const room = await prisma.room.findUnique({
          where: { id: roomId },
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
            landmarks: true,
            referenceImages: {
              select: {
                id: true,
                locationTag: true,
                compassHeading: true,
                capturedAt: true,
                description: true,
              },
            },
          },
        });

        if (!room) {
          return reply.code(404).send({
            error: 'not_found',
            message: 'Room not found',
          });
        }

        request.log.info(`[Rooms] Retrieved room: ${roomId}`);

        return reply.send({
          id: room.id,
          type: room.type,
          name: room.name,
          positionX: room.positionX,
          positionY: room.positionY,
          doorways: room.doorways.map((doorway) => ({
            id: doorway.id,
            toRoomId: doorway.toRoomId,
            toRoomName: doorway.toRoom.name,
            compassHeading: doorway.compassHeading,
            distanceSteps: doorway.distanceSteps,
            type: doorway.type,
            positionX: doorway.positionX,
            positionY: doorway.positionY,
          })),
          landmarks: room.landmarks.map((landmark) => ({
            id: landmark.id,
            name: landmark.name,
            description: landmark.description,
            positionX: landmark.positionX,
            positionY: landmark.positionY,
            compassDirection: landmark.compassDirection,
          })),
          referenceImages: room.referenceImages.map((image) => ({
            id: image.id,
            locationTag: image.locationTag,
            compassHeading: image.compassHeading,
            description: image.description,
            capturedAt: image.capturedAt.toISOString(),
          })),
        });
      } catch (error: any) {
        if (error.statusCode) {
          return reply.code(error.statusCode).send({
            error: error.statusCode === 403 ? 'forbidden' : 'not_found',
            message: error.message,
          });
        }

        request.log.error(`[Rooms] Get error:`, error);
        return reply.code(500).send({
          error: 'internal_error',
          message: 'Failed to get room',
        });
      }
    }
  );

  /**
   * PUT /flats/:flatId/rooms/:roomId
   * Update room details
   */
  fastify.put<{ Params: { flatId: string; roomId: string }; Body: UpdateRoomBody }>(
    '/:roomId',
    {
      preHandler: [fastify.authenticate],
    },
    async (request: AuthenticatedRequest, reply) => {
      if (!request.user) {
        return reply.code(401).send({
          error: 'unauthorized',
          message: 'Not authenticated',
        });
      }

      const { flatId, roomId } = request.params;
      const { type, name, positionX, positionY } = request.body;

      try {
        // Verify room ownership
        await verifyRoomOwnership(flatId, roomId, request.user.id);

        // Build update data
        const updateData: any = {};

        if (type !== undefined) {
          if (!VALID_ROOM_TYPES.includes(type)) {
            return reply.code(400).send({
              error: 'validation_error',
              message: `type must be one of: ${VALID_ROOM_TYPES.join(', ')}`,
            });
          }
          updateData.type = type;
        }

        if (name !== undefined) {
          if (name.trim().length === 0) {
            return reply.code(400).send({
              error: 'validation_error',
              message: 'name cannot be empty',
            });
          }
          updateData.name = name.trim();
        }

        if (positionX !== undefined) {
          updateData.positionX = positionX;
        }

        if (positionY !== undefined) {
          updateData.positionY = positionY;
        }

        // Update room
        const updatedRoom = await prisma.room.update({
          where: { id: roomId },
          data: updateData,
        });

        request.log.info(`[Rooms] Updated room: ${roomId}`);

        return reply.send({
          id: updatedRoom.id,
          type: updatedRoom.type,
          name: updatedRoom.name,
          positionX: updatedRoom.positionX,
          positionY: updatedRoom.positionY,
          updatedAt: updatedRoom.updatedAt.toISOString(),
        });
      } catch (error: any) {
        if (error.statusCode) {
          return reply.code(error.statusCode).send({
            error: error.statusCode === 403 ? 'forbidden' : 'not_found',
            message: error.message,
          });
        }

        request.log.error(`[Rooms] Update error:`, error);
        return reply.code(500).send({
          error: 'internal_error',
          message: 'Failed to update room',
        });
      }
    }
  );

  /**
   * DELETE /flats/:flatId/rooms/:roomId
   * Delete a room
   */
  fastify.delete<{ Params: { flatId: string; roomId: string } }>(
    '/:roomId',
    {
      preHandler: [fastify.authenticate],
    },
    async (request: AuthenticatedRequest, reply) => {
      if (!request.user) {
        return reply.code(401).send({
          error: 'unauthorized',
          message: 'Not authenticated',
        });
      }

      const { flatId, roomId } = request.params;

      try {
        // Verify room ownership
        await verifyRoomOwnership(flatId, roomId, request.user.id);

        // Delete room (cascade will delete doorways, landmarks, images)
        await prisma.room.delete({
          where: { id: roomId },
        });

        request.log.info(`[Rooms] Deleted room: ${roomId}`);

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

        request.log.error(`[Rooms] Delete error:`, error);
        return reply.code(500).send({
          error: 'internal_error',
          message: 'Failed to delete room',
        });
      }
    }
  );

  /**
   * POST /flats/:flatId/rooms/:roomId/doorways
   * Create a doorway connecting this room to another
   */
  fastify.post<{ Params: { flatId: string; roomId: string }; Body: CreateDoorwayBody }>(
    '/:roomId/doorways',
    {
      preHandler: [fastify.authenticate],
    },
    async (request: AuthenticatedRequest, reply) => {
      if (!request.user) {
        return reply.code(401).send({
          error: 'unauthorized',
          message: 'Not authenticated',
        });
      }

      const { flatId, roomId } = request.params;
      const { toRoomId, positionX, positionY, compassHeading, distanceSteps, type } = request.body;

      // Validation
      if (!toRoomId || positionX === undefined || positionY === undefined || compassHeading === undefined) {
        return reply.code(400).send({
          error: 'validation_error',
          message: 'toRoomId, positionX, positionY, and compassHeading are required',
        });
      }

      if (compassHeading < 0 || compassHeading > 360) {
        return reply.code(400).send({
          error: 'validation_error',
          message: 'compassHeading must be between 0 and 360',
        });
      }

      try {
        // Verify both rooms exist and belong to same flat
        const fromRoom = await verifyRoomOwnership(flatId, roomId, request.user.id);
        const toRoom = await verifyRoomOwnership(flatId, toRoomId, request.user.id);

        // Check if doorway already exists
        const existingDoorway = await prisma.doorway.findFirst({
          where: {
            fromRoomId: roomId,
            toRoomId: toRoomId,
          },
        });

        if (existingDoorway) {
          return reply.code(409).send({
            error: 'conflict',
            message: 'Doorway already exists between these rooms',
          });
        }

        // Create forward doorway
        const doorway = await prisma.doorway.create({
          data: {
            fromRoomId: roomId,
            toRoomId: toRoomId,
            positionX,
            positionY,
            compassHeading,
            distanceSteps: distanceSteps || 2,
            type: type || 'door',
          },
        });

        // Create reverse doorway (bidirectional)
        const reverseHeading = (compassHeading + 180) % 360;
        await prisma.doorway.create({
          data: {
            fromRoomId: toRoomId,
            toRoomId: roomId,
            positionX,
            positionY,
            compassHeading: reverseHeading,
            distanceSteps: distanceSteps || 2,
            type: type || 'door',
          },
        });

        request.log.info(`[Rooms] Created doorway: ${doorway.id} from ${roomId} to ${toRoomId}`);

        return reply.code(201).send({
          id: doorway.id,
          fromRoomId: doorway.fromRoomId,
          toRoomId: doorway.toRoomId,
          positionX: doorway.positionX,
          positionY: doorway.positionY,
          compassHeading: doorway.compassHeading,
          distanceSteps: doorway.distanceSteps,
          type: doorway.type,
        });
      } catch (error: any) {
        if (error.statusCode) {
          return reply.code(error.statusCode).send({
            error: error.statusCode === 403 ? 'forbidden' : 'not_found',
            message: error.message,
          });
        }

        request.log.error(`[Rooms] Create doorway error:`, error);
        return reply.code(500).send({
          error: 'internal_error',
          message: 'Failed to create doorway',
        });
      }
    }
  );

  /**
   * DELETE /flats/:flatId/rooms/:roomId/doorways/:doorwayId
   * Delete a doorway
   */
  fastify.delete<{ Params: { flatId: string; roomId: string; doorwayId: string } }>(
    '/:roomId/doorways/:doorwayId',
    {
      preHandler: [fastify.authenticate],
    },
    async (request: AuthenticatedRequest, reply) => {
      if (!request.user) {
        return reply.code(401).send({
          error: 'unauthorized',
          message: 'Not authenticated',
        });
      }

      const { flatId, roomId, doorwayId } = request.params;

      try {
        // Verify room ownership
        await verifyRoomOwnership(flatId, roomId, request.user.id);

        // Get doorway to find reverse
        const doorway = await prisma.doorway.findUnique({
          where: { id: doorwayId },
        });

        if (!doorway) {
          return reply.code(404).send({
            error: 'not_found',
            message: 'Doorway not found',
          });
        }

        if (doorway.fromRoomId !== roomId) {
          return reply.code(403).send({
            error: 'forbidden',
            message: 'Doorway does not belong to this room',
          });
        }

        // Find and delete reverse doorway
        const reverseDoorway = await prisma.doorway.findFirst({
          where: {
            fromRoomId: doorway.toRoomId,
            toRoomId: doorway.fromRoomId,
          },
        });

        // Delete both doorways
        await Promise.all([
          prisma.doorway.delete({
            where: { id: doorwayId },
          }),
          reverseDoorway
            ? prisma.doorway.delete({
                where: { id: reverseDoorway.id },
              })
            : Promise.resolve(),
        ]);

        request.log.info(`[Rooms] Deleted doorway: ${doorwayId}`);

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

        request.log.error(`[Rooms] Delete doorway error:`, error);
        return reply.code(500).send({
          error: 'internal_error',
          message: 'Failed to delete doorway',
        });
      }
    }
  );

  /**
   * POST /flats/:flatId/rooms/:roomId/landmarks
   * Add a landmark to a room
   */
  fastify.post<{ Params: { flatId: string; roomId: string }; Body: CreateLandmarkBody }>(
    '/:roomId/landmarks',
    {
      preHandler: [fastify.authenticate],
    },
    async (request: AuthenticatedRequest, reply) => {
      if (!request.user) {
        return reply.code(401).send({
          error: 'unauthorized',
          message: 'Not authenticated',
        });
      }

      const { flatId, roomId } = request.params;
      const { name, description, positionX, positionY, compassDirection } = request.body;

      // Validation
      if (!name || positionX === undefined || positionY === undefined) {
        return reply.code(400).send({
          error: 'validation_error',
          message: 'name, positionX, and positionY are required',
        });
      }

      if (name.trim().length === 0) {
        return reply.code(400).send({
          error: 'validation_error',
          message: 'name cannot be empty',
        });
      }

      try {
        // Verify room ownership
        await verifyRoomOwnership(flatId, roomId, request.user.id);

        // Create landmark
        const landmark = await prisma.landmark.create({
          data: {
            roomId,
            name: name.trim(),
            description: description?.trim() || null,
            positionX,
            positionY,
            compassDirection: compassDirection !== undefined ? compassDirection : null,
          },
        });

        request.log.info(`[Rooms] Created landmark: ${landmark.id} in room ${roomId}`);

        return reply.code(201).send({
          id: landmark.id,
          name: landmark.name,
          description: landmark.description,
          positionX: landmark.positionX,
          positionY: landmark.positionY,
          compassDirection: landmark.compassDirection,
        });
      } catch (error: any) {
        if (error.statusCode) {
          return reply.code(error.statusCode).send({
            error: error.statusCode === 403 ? 'forbidden' : 'not_found',
            message: error.message,
          });
        }

        request.log.error(`[Rooms] Create landmark error:`, error);
        return reply.code(500).send({
          error: 'internal_error',
          message: 'Failed to create landmark',
        });
      }
    }
  );

  /**
   * DELETE /flats/:flatId/rooms/:roomId/landmarks/:landmarkId
   * Delete a landmark
   */
  fastify.delete<{ Params: { flatId: string; roomId: string; landmarkId: string } }>(
    '/:roomId/landmarks/:landmarkId',
    {
      preHandler: [fastify.authenticate],
    },
    async (request: AuthenticatedRequest, reply) => {
      if (!request.user) {
        return reply.code(401).send({
          error: 'unauthorized',
          message: 'Not authenticated',
        });
      }

      const { flatId, roomId, landmarkId } = request.params;

      try {
        // Verify room ownership
        await verifyRoomOwnership(flatId, roomId, request.user.id);

        // Verify landmark belongs to room
        const landmark = await prisma.landmark.findUnique({
          where: { id: landmarkId },
        });

        if (!landmark) {
          return reply.code(404).send({
            error: 'not_found',
            message: 'Landmark not found',
          });
        }

        if (landmark.roomId !== roomId) {
          return reply.code(403).send({
            error: 'forbidden',
            message: 'Landmark does not belong to this room',
          });
        }

        // Delete landmark
        await prisma.landmark.delete({
          where: { id: landmarkId },
        });

        request.log.info(`[Rooms] Deleted landmark: ${landmarkId}`);

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

        request.log.error(`[Rooms] Delete landmark error:`, error);
        return reply.code(500).send({
          error: 'internal_error',
          message: 'Failed to delete landmark',
        });
      }
    }
  );
}
