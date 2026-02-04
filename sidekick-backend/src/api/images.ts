import type { FastifyInstance, FastifyRequest } from 'fastify';
import { prisma } from '../db/client';
import { VisionClient } from '../services/VisionClient';
import { config } from '../config';

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
 * Upload image request body
 */
interface UploadImageBody {
  imageData: string; // Base64 encoded
  locationTag: string;
  compassHeading: number;
}

/**
 * Update image metadata request body
 */
interface UpdateImageBody {
  locationTag?: string;
  compassHeading?: number;
  description?: string;
}

/**
 * Image validation result
 */
interface ImageValidationResult {
  valid: boolean;
  error?: string;
  sizeBytes?: number;
}

/**
 * Maximum image size in bytes (5MB)
 */
const MAX_IMAGE_SIZE_BYTES = 5 * 1024 * 1024; // 5MB

/**
 * Maximum images per room
 */
const MAX_IMAGES_PER_ROOM = 10;

/**
 * Vision client instance (lazy initialized)
 */
let visionClient: VisionClient | null = null;

function getVisionClient(): VisionClient | null {
  if (!visionClient && config.VISION_API_URL) {
    visionClient = new VisionClient(config.VISION_API_URL);
  }
  return visionClient;
}

/**
 * Verify room ownership (reuse from rooms.ts pattern)
 */
async function verifyRoomOwnership(
  flatId: string,
  roomId: string,
  userId: string
): Promise<void> {
  // Verify flat ownership
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

  // Verify room exists and belongs to flat
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
}

/**
 * Validate base64 image
 * 
 * @param imageData - Base64 encoded image string
 * @returns Validation result with size information
 */
function validateBase64Image(imageData: string): ImageValidationResult {
  if (!imageData || typeof imageData !== 'string') {
    return {
      valid: false,
      error: 'Image data is required',
    };
  }

  // Remove data URL prefix if present (data:image/jpeg;base64,)
  const base64Data = imageData.includes(',') ? imageData.split(',')[1] : imageData;

  // Check if it's valid base64
  const base64Regex = /^[A-Za-z0-9+/]*={0,2}$/;
  if (!base64Regex.test(base64Data)) {
    return {
      valid: false,
      error: 'Invalid base64 format',
    };
  }

  // Check if it's a JPEG or PNG
  // JPEG base64 starts with /9j/ (FF D8 FF in hex)
  // PNG base64 starts with iVBORw0KGgo (89 50 4E 47 in hex)
  const jpegPrefix = '/9j/';
  const pngPrefix = 'iVBORw0KGgo';
  if (!base64Data.startsWith(jpegPrefix) && !base64Data.startsWith(pngPrefix)) {
    return {
      valid: false,
      error: 'Image must be JPEG or PNG format',
    };
  }

  // Calculate decoded size
  // Base64 encoding increases size by ~33%, so we estimate
  const sizeBytes = Math.floor((base64Data.length * 3) / 4);

  if (sizeBytes > MAX_IMAGE_SIZE_BYTES) {
    return {
      valid: false,
      error: `Image size exceeds maximum of ${MAX_IMAGE_SIZE_BYTES / 1024 / 1024}MB`,
      sizeBytes,
    };
  }

  return {
    valid: true,
    sizeBytes,
  };
}

/**
 * Reference image management routes plugin
 * 
 * Handles upload, listing, retrieval, and deletion of reference images.
 * All endpoints require authentication and are nested under /flats/:flatId/rooms/:roomId/images
 * 
 * @param fastify - Fastify instance
 */
export default async function imageRoutes(fastify: FastifyInstance) {
  /**
   * POST /flats/:flatId/rooms/:roomId/images
   * Upload a reference image
   */
  fastify.post<{ Params: { flatId: string; roomId: string }; Body: UploadImageBody }>(
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

      const { flatId, roomId } = request.params as { flatId: string; roomId: string };
      const { imageData, locationTag, compassHeading } = request.body as UploadImageBody;

      // Validation
      if (!imageData || !locationTag || compassHeading === undefined) {
        return reply.code(400).send({
          error: 'validation_error',
          message: 'imageData, locationTag, and compassHeading are required',
        });
      }

      if (locationTag.trim().length === 0) {
        return reply.code(400).send({
          error: 'validation_error',
          message: 'locationTag cannot be empty',
        });
      }

      if (compassHeading < 0 || compassHeading > 360) {
        return reply.code(400).send({
          error: 'validation_error',
          message: 'compassHeading must be between 0 and 360',
        });
      }

      // Validate image
      const validation = validateBase64Image(imageData);
      if (!validation.valid) {
        return reply.code(400).send({
          error: 'validation_error',
          message: validation.error,
        });
      }

      try {
        // Verify room ownership
        await verifyRoomOwnership(flatId, roomId, authUser.userId);

        // Check image count limit
        const imageCount = await prisma.referenceImage.count({
          where: { roomId },
        });

        if (imageCount >= MAX_IMAGES_PER_ROOM) {
          return reply.code(400).send({
            error: 'validation_error',
            message: `Maximum ${MAX_IMAGES_PER_ROOM} images per room`,
          });
        }

        // Optionally call Vision API to get description and landmarks
        let description: string | null = null;
        let detectedLandmarks: string[] | null = null;

        const client = getVisionClient();
        if (client) {
          try {
            request.log.info(`[Images] Calling Vision API for image analysis`);
            const visionResult = await client.identifyRoom(imageData);

            if (visionResult.success) {
              description = visionResult.speech || null;
              // Extract landmarks from keyFeatures if available
              if (visionResult.keyFeatures && visionResult.keyFeatures.length > 0) {
                detectedLandmarks = visionResult.keyFeatures;
              }
            }
          } catch (visionError) {
            // Don't fail image upload if Vision API fails
            request.log.warn({ err: visionError }, '[Images] Vision API error (continuing anyway)');
          }
        }

        // Create reference image
        const image = await prisma.referenceImage.create({
          data: {
            roomId,
            locationTag: locationTag.trim(),
            compassHeading,
            imageData,
            description,
            detectedLandmarks: detectedLandmarks ? JSON.stringify(detectedLandmarks) : null,
          },
        });

        request.log.info(`[Images] Created reference image: ${image.id} for room ${roomId}`);

        return reply.code(201).send({
          id: image.id,
          locationTag: image.locationTag,
          compassHeading: image.compassHeading,
          description: image.description,
          detectedLandmarks: image.detectedLandmarks
            ? JSON.parse(image.detectedLandmarks)
            : null,
          capturedAt: image.capturedAt.toISOString(),
        });
      } catch (error: any) {
        if (error.statusCode) {
          return reply.code(error.statusCode).send({
            error: error.statusCode === 403 ? 'forbidden' : 'not_found',
            message: error.message,
          });
        }

        request.log.error({ err: error }, '[Images] Upload error');
        return reply.code(500).send({
          error: 'internal_error',
          message: 'Failed to upload image',
        });
      }
    }
  );

  /**
   * GET /flats/:flatId/rooms/:roomId/images
   * List all reference images for a room (metadata only)
   */
  fastify.get<{ Params: { flatId: string; roomId: string } }>(
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

      const { flatId, roomId } = request.params as { flatId: string; roomId: string };

      try {
        // Verify room ownership
        await verifyRoomOwnership(flatId, roomId, authUser.userId);

        // Get images (without imageData)
        const images = await prisma.referenceImage.findMany({
          where: { roomId },
          select: {
            id: true,
            locationTag: true,
            compassHeading: true,
            description: true,
            detectedLandmarks: true,
            capturedAt: true,
          },
          orderBy: { capturedAt: 'desc' },
        });

        request.log.info(`[Images] Listed ${images.length} images for room ${roomId}`);

        return reply.send({
          images: images.map((image: any) => ({
            id: image.id,
            locationTag: image.locationTag,
            compassHeading: image.compassHeading,
            description: image.description,
            detectedLandmarks: image.detectedLandmarks
              ? JSON.parse(image.detectedLandmarks)
              : null,
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

        request.log.error({ err: error }, '[Images] List error');
        return reply.code(500).send({
          error: 'internal_error',
          message: 'Failed to list images',
        });
      }
    }
  );

  /**
   * GET /flats/:flatId/rooms/:roomId/images/:imageId
   * Get a single image INCLUDING the image data
   */
  fastify.get<{ Params: { flatId: string; roomId: string; imageId: string } }>(
    '/:imageId',
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

      const { flatId, roomId, imageId } = request.params as { flatId: string; roomId: string; imageId: string };

      try {
        // Verify room ownership
        await verifyRoomOwnership(flatId, roomId, authUser.userId);

        // Get image with data
        const image = await prisma.referenceImage.findUnique({
          where: { id: imageId },
        });

        if (!image) {
          return reply.code(404).send({
            error: 'not_found',
            message: 'Image not found',
          });
        }

        if (image.roomId !== roomId) {
          return reply.code(403).send({
            error: 'forbidden',
            message: 'Image does not belong to this room',
          });
        }

        request.log.info(`[Images] Retrieved image: ${imageId}`);

        return reply.send({
          id: image.id,
          locationTag: image.locationTag,
          compassHeading: image.compassHeading,
          description: image.description,
          detectedLandmarks: image.detectedLandmarks
            ? JSON.parse(image.detectedLandmarks)
            : null,
          imageData: image.imageData,
          capturedAt: image.capturedAt.toISOString(),
        });
      } catch (error: any) {
        if (error.statusCode) {
          return reply.code(error.statusCode).send({
            error: error.statusCode === 403 ? 'forbidden' : 'not_found',
            message: error.message,
          });
        }

        request.log.error({ err: error }, '[Images] Get error');
        return reply.code(500).send({
          error: 'internal_error',
          message: 'Failed to get image',
        });
      }
    }
  );

  /**
   * PUT /flats/:flatId/rooms/:roomId/images/:imageId
   * Update image metadata (not the image itself)
   */
  fastify.put<{
    Params: { flatId: string; roomId: string; imageId: string };
    Body: UpdateImageBody;
  }>(
    '/:imageId',
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

      const { flatId, roomId, imageId } = request.params as { flatId: string; roomId: string; imageId: string };
      const { locationTag, compassHeading, description } = request.body as UpdateImageBody;

      try {
        // Verify room ownership
        await verifyRoomOwnership(flatId, roomId, authUser.userId);

        // Verify image belongs to room
        const image = await prisma.referenceImage.findUnique({
          where: { id: imageId },
        });

        if (!image) {
          return reply.code(404).send({
            error: 'not_found',
            message: 'Image not found',
          });
        }

        if (image.roomId !== roomId) {
          return reply.code(403).send({
            error: 'forbidden',
            message: 'Image does not belong to this room',
          });
        }

        // Build update data
        const updateData: any = {};

        if (locationTag !== undefined) {
          if (locationTag.trim().length === 0) {
            return reply.code(400).send({
              error: 'validation_error',
              message: 'locationTag cannot be empty',
            });
          }
          updateData.locationTag = locationTag.trim();
        }

        if (compassHeading !== undefined) {
          if (compassHeading < 0 || compassHeading > 360) {
            return reply.code(400).send({
              error: 'validation_error',
              message: 'compassHeading must be between 0 and 360',
            });
          }
          updateData.compassHeading = compassHeading;
        }

        if (description !== undefined) {
          updateData.description = description?.trim() || null;
        }

        // Update image
        const updatedImage = await prisma.referenceImage.update({
          where: { id: imageId },
          data: updateData,
        });

        request.log.info(`[Images] Updated image metadata: ${imageId}`);

        return reply.send({
          id: updatedImage.id,
          locationTag: updatedImage.locationTag,
          compassHeading: updatedImage.compassHeading,
          description: updatedImage.description,
          detectedLandmarks: updatedImage.detectedLandmarks
            ? JSON.parse(updatedImage.detectedLandmarks)
            : null,
          capturedAt: updatedImage.capturedAt.toISOString(),
        });
      } catch (error: any) {
        if (error.statusCode) {
          return reply.code(error.statusCode).send({
            error: error.statusCode === 403 ? 'forbidden' : 'not_found',
            message: error.message,
          });
        }

        request.log.error({ err: error }, '[Images] Update error');
        return reply.code(500).send({
          error: 'internal_error',
          message: 'Failed to update image',
        });
      }
    }
  );

  /**
   * DELETE /flats/:flatId/rooms/:roomId/images/:imageId
   * Delete a reference image
   */
  fastify.delete<{ Params: { flatId: string; roomId: string; imageId: string } }>(
    '/:imageId',
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

      const { flatId, roomId, imageId } = request.params as { flatId: string; roomId: string; imageId: string };

      try {
        // Verify room ownership
        await verifyRoomOwnership(flatId, roomId, authUser.userId);

        // Verify image belongs to room
        const image = await prisma.referenceImage.findUnique({
          where: { id: imageId },
        });

        if (!image) {
          return reply.code(404).send({
            error: 'not_found',
            message: 'Image not found',
          });
        }

        if (image.roomId !== roomId) {
          return reply.code(403).send({
            error: 'forbidden',
            message: 'Image does not belong to this room',
          });
        }

        // Delete image
        await prisma.referenceImage.delete({
          where: { id: imageId },
        });

        request.log.info(`[Images] Deleted image: ${imageId}`);

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

        request.log.error({ err: error }, '[Images] Delete error');
        return reply.code(500).send({
          error: 'internal_error',
          message: 'Failed to delete image',
        });
      }
    }
  );

  /**
   * POST /flats/:flatId/rooms/:roomId/images/:imageId/analyze
   * Re-analyze an existing image with Vision API
   */
  fastify.post<{ Params: { flatId: string; roomId: string; imageId: string } }>(
    '/:imageId/analyze',
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

      const { flatId, roomId, imageId } = request.params as { flatId: string; roomId: string; imageId: string };

      try {
        // Verify room ownership
        await verifyRoomOwnership(flatId, roomId, authUser.userId);

        // Get image
        const image = await prisma.referenceImage.findUnique({
          where: { id: imageId },
        });

        if (!image) {
          return reply.code(404).send({
            error: 'not_found',
            message: 'Image not found',
          });
        }

        if (image.roomId !== roomId) {
          return reply.code(403).send({
            error: 'forbidden',
            message: 'Image does not belong to this room',
          });
        }

        // Call Vision API
        const client = getVisionClient();
        if (!client) {
          return reply.code(503).send({
            error: 'service_unavailable',
            message: 'Vision API is not configured',
          });
        }

        request.log.info(`[Images] Re-analyzing image: ${imageId}`);

        const visionResult = await client.identifyRoom(image.imageData);

        if (!visionResult.success) {
          return reply.code(500).send({
            error: 'vision_api_error',
            message: visionResult.speech || 'Failed to analyze image',
          });
        }

        // Update image with new analysis
        let description: string | null = visionResult.speech || null;
        let detectedLandmarks: string[] | null = null;

        if (visionResult.keyFeatures && visionResult.keyFeatures.length > 0) {
          detectedLandmarks = visionResult.keyFeatures;
        }

        const updatedImage = await prisma.referenceImage.update({
          where: { id: imageId },
          data: {
            description,
            detectedLandmarks: detectedLandmarks ? JSON.stringify(detectedLandmarks) : null,
          },
        });

        request.log.info(`[Images] Re-analyzed image: ${imageId}`);

        return reply.send({
          id: updatedImage.id,
          locationTag: updatedImage.locationTag,
          compassHeading: updatedImage.compassHeading,
          description: updatedImage.description,
          detectedLandmarks: updatedImage.detectedLandmarks
            ? JSON.parse(updatedImage.detectedLandmarks)
            : null,
          capturedAt: updatedImage.capturedAt.toISOString(),
        });
      } catch (error: any) {
        if (error.statusCode) {
          return reply.code(error.statusCode).send({
            error: error.statusCode === 403 ? 'forbidden' : 'not_found',
            message: error.message,
          });
        }

        request.log.error({ err: error }, '[Images] Analyze error');
        return reply.code(500).send({
          error: 'internal_error',
          message: 'Failed to analyze image',
        });
      }
    }
  );
}
