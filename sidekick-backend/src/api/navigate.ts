import type { FastifyInstance, FastifyRequest } from 'fastify';
import { prisma } from '../db/client.js';
import type { SensorUpdatePayload, VisualResponsePayload } from '../services/NavigationEngine.js';
import type { VisualTrigger } from '../services/TriggerEvaluator.js';

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
 * Start navigation request body
 */
interface StartNavigationBody {
  flatMapId: string;
  destinationRoomId: string;
  currentRoomId?: string;
  currentCompassHeading?: number;
}

/**
 * Update navigation request body
 */
interface UpdateNavigationBody {
  stepsSinceLastUpdate: number;
  totalStepsInSegment: number;
  compassHeading: number;
  isMoving: boolean;
}

/**
 * Visual confirmation request body
 */
interface VisualConfirmationBody {
  currentImage: string;
  referenceImage: string;
  compassHeading: number;
}

/**
 * Request visual payload (extracted from VisualTrigger)
 */
interface RequestVisualPayload {
  reason: string;
  priority: string;
  message: string;
  capture: {
    mode: string;
    delaySeconds: number;
    guidanceAudio: string;
    expectedHeading?: number;
  };
  validation: {
    query: string;
    expectedRoom: string;
    expectedLandmarks: string[];
    referenceImageId: string | null;
  };
}

/**
 * Rate limiting map for update endpoint
 * Key: sessionId, Value: last request timestamp
 */
const updateRateLimit = new Map<string, number>();

/**
 * Rate limit: max 2 requests per second per session
 */
const UPDATE_RATE_LIMIT_MS = 500; // 500ms = 2 requests per second

/**
 * Verify session ownership
 */
async function verifySessionOwnership(
  sessionId: string,
  userId: string
): Promise<{
  id: string;
  userId: string;
  status: string;
}> {
  const session = await prisma.navigationSession.findUnique({
    where: { id: sessionId },
    select: {
      id: true,
      userId: true,
      status: true,
    },
  });

  if (!session) {
    const error: any = new Error('Navigation session not found');
    error.statusCode = 404;
    throw error;
  }

  if (session.userId !== userId) {
    const error: any = new Error('Navigation session does not belong to user');
    error.statusCode = 403;
    throw error;
  }

  return session;
}

/**
 * Check rate limit for update endpoint
 */
function checkRateLimit(sessionId: string): boolean {
  const lastRequest = updateRateLimit.get(sessionId);
  const now = Date.now();

  if (lastRequest && now - lastRequest < UPDATE_RATE_LIMIT_MS) {
    return false; // Rate limited
  }

  updateRateLimit.set(sessionId, now);
  return true; // Allowed
}

/**
 * Extract visual request from messages
 */
function extractVisualRequest(messages: any[]): RequestVisualPayload | undefined {
  const visualMessage = messages.find((msg) => msg.type === 'request_visual');
  if (!visualMessage || !visualMessage.trigger) {
    return undefined;
  }

  const trigger: VisualTrigger = visualMessage.trigger;
  return {
    reason: trigger.reason,
    priority: trigger.priority,
    message: trigger.message,
    capture: {
      mode: trigger.capture.mode,
      delaySeconds: trigger.capture.delaySeconds,
      guidanceAudio: trigger.capture.guidanceAudio,
      expectedHeading: trigger.capture.expectedHeading,
    },
    validation: {
      query: trigger.validation.query,
      expectedRoom: trigger.validation.expectedRoom,
      expectedLandmarks: trigger.validation.expectedLandmarks,
      referenceImageId: trigger.validation.referenceImageId,
    },
  };
}

/**
 * Extract instruction from messages
 */
function extractInstruction(messages: any[]): string | undefined {
  const instructionMessage = messages.find((msg) => msg.type === 'instruction');
  return instructionMessage?.speech;
}

/**
 * Navigation REST endpoints plugin
 * 
 * Provides REST API fallback for navigation when WebSocket is unavailable.
 * All endpoints require authentication.
 * 
 * @param fastify - Fastify instance
 */
export default async function navigateRoutes(fastify: FastifyInstance) {
  // Get NavigationEngine from app context
  const navigationEngine = (fastify as any).navigationEngine;
  if (!navigationEngine) {
    throw new Error('NavigationEngine not available');
  }

  /**
   * POST /navigate/start
   * Start a new navigation session
   */
  fastify.post<{ Body: StartNavigationBody }>(
    '/start',
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

      const { flatMapId, destinationRoomId, currentRoomId, currentCompassHeading } = request.body as StartNavigationBody;

      // Validation
      if (!flatMapId || !destinationRoomId) {
        return reply.code(400).send({
          error: 'validation_error',
          message: 'flatMapId and destinationRoomId are required',
        });
      }

      try {
        // Start navigation
        const { session, messages } = await navigationEngine.startNavigation(
          authUser.userId,
          flatMapId,
          destinationRoomId,
          currentRoomId,
          currentCompassHeading || 0
        );

        // Extract instruction and visual request from messages
        const instruction = extractInstruction(messages) || messages[0]?.firstInstruction || '';
        const visualRequest = extractVisualRequest(messages);

        request.log.info(`[Navigate] Navigation started: sessionId=${session.id}`);

        return reply.send({
          sessionId: session.id,
          status: session.status,
          path: session.path,
          instruction,
          totalSteps: session.path.reduce((sum: number, seg: any) => sum + seg.distanceSteps, 0),
          visualRequest,
        });
      } catch (error: any) {
        request.log.error({ err: error }, '[Navigate] Start error');
        return reply.code(500).send({
          error: 'internal_error',
          message: error.message || 'Failed to start navigation',
        });
      }
    }
  );

  /**
   * POST /navigate/:sessionId/update
   * Send sensor update and get next instruction
   */
  fastify.post<{ Params: { sessionId: string }; Body: UpdateNavigationBody }>(
    '/:sessionId/update',
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

      const { sessionId } = request.params as { sessionId: string };
      const payload = request.body as SensorUpdatePayload;

      // Validation
      if (
        payload.stepsSinceLastUpdate === undefined ||
        payload.totalStepsInSegment === undefined ||
        payload.compassHeading === undefined ||
        payload.isMoving === undefined
      ) {
        return reply.code(400).send({
          error: 'validation_error',
          message: 'All sensor fields are required',
        });
      }

      // Check rate limit
      if (!checkRateLimit(sessionId)) {
        return reply.code(429).send({
          error: 'rate_limit',
          message: 'Too many requests. Maximum 2 requests per second.',
        });
      }

      try {
        // Verify session ownership
        await verifySessionOwnership(sessionId, authUser.userId);

        // Process sensor update
        const messages = await navigationEngine.processSensorUpdate(sessionId, payload);

        // Get session for status
        const session = navigationEngine.getSession(sessionId);
        if (!session) {
          return reply.code(404).send({
            error: 'not_found',
            message: 'Navigation session not found',
          });
        }

        // Extract instruction and visual request
        const instruction = extractInstruction(messages);
        const visualRequest = extractVisualRequest(messages);

        // Check if navigation is complete
        const complete = session.status === 'completed';
        const currentSegment = session.path[session.currentSegmentIndex];
        const stepsRemaining = complete
          ? 0
          : Math.max(0, (currentSegment?.distanceSteps || 0) - session.stepsTakenInSegment);

        return reply.send({
          status: session.status,
          instruction,
          visualRequest,
          confidence: session.confidence,
          stepsRemaining,
          complete,
        });
      } catch (error: any) {
        if (error.statusCode) {
          return reply.code(error.statusCode).send({
            error: error.statusCode === 403 ? 'forbidden' : 'not_found',
            message: error.message,
          });
        }

        request.log.error({ err: error }, '[Navigate] Update error');
        return reply.code(500).send({
          error: 'internal_error',
          message: error.message || 'Failed to process sensor update',
        });
      }
    }
  );

  /**
   * POST /navigate/:sessionId/visual
   * Submit visual confirmation
   */
  fastify.post<{ Params: { sessionId: string }; Body: VisualConfirmationBody }>(
    '/:sessionId/visual',
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

      const { sessionId } = request.params as { sessionId: string };
      const body = request.body as VisualConfirmationBody;
      const payload: VisualResponsePayload = {
        currentImage: body.currentImage,
        referenceImage: body.referenceImage,
        compassHeading: body.compassHeading,
        capturedAt: Date.now(),
      };

      // Validation
      if (!payload.currentImage || !payload.referenceImage || payload.compassHeading === undefined) {
        return reply.code(400).send({
          error: 'validation_error',
          message: 'currentImage, referenceImage, and compassHeading are required',
        });
      }

      try {
        // Verify session ownership
        await verifySessionOwnership(sessionId, authUser.userId);

        // Process visual response
        const messages = await navigationEngine.processVisualResponse(sessionId, payload);

        // Extract visual result and instruction
        const visualResult = messages.find((msg: any) => msg.type === 'visual_result');
        const instruction = extractInstruction(messages);

        if (!visualResult || visualResult.type !== 'visual_result') {
          return reply.code(500).send({
            error: 'internal_error',
            message: 'Failed to process visual confirmation',
          });
        }

        return reply.send({
          success: visualResult.success,
          isOnTrack: visualResult.isOnTrack,
          confidence: visualResult.confidence,
          instruction,
          speech: visualResult.speech,
        });
      } catch (error: any) {
        if (error.statusCode) {
          return reply.code(error.statusCode).send({
            error: error.statusCode === 403 ? 'forbidden' : 'not_found',
            message: error.message,
          });
        }

        request.log.error({ err: error }, '[Navigate] Visual error');
        return reply.code(500).send({
          error: 'internal_error',
          message: error.message || 'Failed to process visual confirmation',
        });
      }
    }
  );

  /**
   * GET /navigate/:sessionId/status
   * Get current session status (for polling)
   */
  fastify.get<{ Params: { sessionId: string } }>(
    '/:sessionId/status',
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

      const { sessionId } = request.params as { sessionId: string };

      try {
        // Verify session ownership
        await verifySessionOwnership(sessionId, authUser.userId);

        // Get session from memory or load from database
        const session = await navigationEngine.getSessionOrLoadFromDb(sessionId);
        if (!session) {
          return reply.code(404).send({
            error: 'not_found',
            message: 'Navigation session not found',
          });
        }

        // Generate current instruction
        const currentSegment = session.path[session.currentSegmentIndex];
        const stepsRemaining = currentSegment
          ? Math.max(0, currentSegment.distanceSteps - session.stepsTakenInSegment)
          : 0;

        // Get instruction if available
        let instruction: string | undefined;
        try {
          const directionTranslator = (fastify as any).directionTranslator;
          if (directionTranslator && currentSegment) {
            instruction = directionTranslator.generateInstruction(
              currentSegment.action,
              currentSegment.compassHeading,
              session.currentCompassHeading,
              stepsRemaining,
              currentSegment.expectedLandmarks[0]
            );
          }
        } catch {
          // Ignore instruction generation errors
        }

        return reply.send({
          sessionId: session.id,
          status: session.status,
          currentSegmentIndex: session.currentSegmentIndex,
          stepsRemaining,
          confidence: session.confidence,
          pendingVisualRequest: session.pendingVisualRequest,
          instruction,
        });
      } catch (error: any) {
        if (error.statusCode) {
          return reply.code(error.statusCode).send({
            error: error.statusCode === 403 ? 'forbidden' : 'not_found',
            message: error.message,
          });
        }

        request.log.error({ err: error }, '[Navigate] Status error');
        return reply.code(500).send({
          error: 'internal_error',
          message: 'Failed to get session status',
        });
      }
    }
  );

  /**
   * POST /navigate/:sessionId/cancel
   * Cancel navigation
   */
  fastify.post<{ Params: { sessionId: string } }>(
    '/:sessionId/cancel',
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

      const { sessionId } = request.params as { sessionId: string };

      try {
        // Verify session ownership
        await verifySessionOwnership(sessionId, authUser.userId);

        // Cancel navigation
        const messages = await navigationEngine.cancelNavigation(sessionId);

        const cancelMessage = messages.find((msg: any) => msg.type === 'navigation_cancelled');

        return reply.send({
          success: true,
          speech: cancelMessage?.speech || 'Navigation cancelled.',
        });
      } catch (error: any) {
        if (error.statusCode) {
          return reply.code(error.statusCode).send({
            error: error.statusCode === 403 ? 'forbidden' : 'not_found',
            message: error.message,
          });
        }

        request.log.error({ err: error }, '[Navigate] Cancel error');
        return reply.code(500).send({
          error: 'internal_error',
          message: 'Failed to cancel navigation',
        });
      }
    }
  );

  /**
   * POST /navigate/:sessionId/pause
   * Pause navigation
   */
  fastify.post<{ Params: { sessionId: string } }>(
    '/:sessionId/pause',
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

      const { sessionId } = request.params as { sessionId: string };

      try {
        // Verify session ownership
        await verifySessionOwnership(sessionId, authUser.userId);

        // Pause navigation
        const messages = await navigationEngine.pauseNavigation(sessionId);

        const pauseMessage = messages.find((msg: any) => msg.type === 'instruction');

        return reply.send({
          success: true,
          speech: pauseMessage?.speech || 'Navigation paused.',
        });
      } catch (error: any) {
        if (error.statusCode) {
          return reply.code(error.statusCode).send({
            error: error.statusCode === 403 ? 'forbidden' : 'not_found',
            message: error.message,
          });
        }

        request.log.error({ err: error }, '[Navigate] Pause error');
        return reply.code(500).send({
          error: 'internal_error',
          message: 'Failed to pause navigation',
        });
      }
    }
  );

  /**
   * POST /navigate/:sessionId/resume
   * Resume navigation
   */
  fastify.post<{ Params: { sessionId: string } }>(
    '/:sessionId/resume',
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

      const { sessionId } = request.params as { sessionId: string };

      try {
        // Verify session ownership
        await verifySessionOwnership(sessionId, authUser.userId);

        // Resume navigation
        const messages = await navigationEngine.resumeNavigation(sessionId);

        const instructionMessage = messages.find((msg: any) => msg.type === 'instruction');

        return reply.send({
          success: true,
          instruction: instructionMessage?.speech || 'Navigation resumed.',
          speech: instructionMessage?.speech || 'Navigation resumed.',
        });
      } catch (error: any) {
        if (error.statusCode) {
          return reply.code(error.statusCode).send({
            error: error.statusCode === 403 ? 'forbidden' : 'not_found',
            message: error.message,
          });
        }

        request.log.error({ err: error }, '[Navigate] Resume error');
        return reply.code(500).send({
          error: 'internal_error',
          message: 'Failed to resume navigation',
        });
      }
    }
  );
}
