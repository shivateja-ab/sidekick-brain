import type { PrismaClient } from '@prisma/client';
import { logger } from '../utils/logger.js';
import type {
  NavigationSessionRuntime,
  PathSegment,
} from '../models/NavigationSession.js';
import type { Doorway } from '../models/Doorway.js';
import { PathFinder } from './PathFinder.js';
import { PositionTracker } from './PositionTracker.js';
import { DirectionTranslator } from './DirectionTranslator.js';
import { TriggerEvaluator, type VisualTrigger } from './TriggerEvaluator.js';

/**
 * VisionClient interface - handles calls to Vision API
 */
interface VisionClient {
  validatePosition(
    currentImage: string,
    referenceImage: string,
    context: {
      expectedRoom: string;
      expectedLandmarks: string[];
      compassHeading: number;
    }
  ): Promise<{
    success: boolean;
    isOnTrack?: boolean;
    confidence?: number;
    detectedRoom?: string;
    detectedLandmarks?: string[];
    speech: string;
    error?: string;
  }>;
}

/**
 * Step batch with heading information
 */
export interface StepBatch {
  steps: number;      // Number of steps in this batch
  heading: number;    // Compass heading (0-360) when steps were taken
  timestamp: number;  // When this batch was recorded
}

/**
 * Sensor update payload from mobile client
 */
export interface SensorUpdatePayload {
  // Legacy fields (for backward compatibility)
  stepsSinceLastUpdate?: number;
  totalStepsInSegment?: number;
  compassHeading?: number;

  // New batch-based fields
  currentHeading: number;       // Current compass heading
  stepBatches?: StepBatch[];     // Array of step batches with headings
  isMoving: boolean;            // Is user currently moving
  timestamp: number;            // Message timestamp
}

/**
 * Visual response payload from mobile client
 */
export interface VisualResponsePayload {
  currentImage: string; // base64 encoded
  referenceImage: string; // base64 encoded
  compassHeading: number;
  capturedAt: number; // timestamp
}

/**
 * Server message types sent to client via WebSocket
 */
export type ServerMessage = {
  sessionId?: string;
  timestamp?: number;
} & (
    | {
      type: 'connection_established';
      payload: {
        userId: string;
        clientId: string;
      };
    }
    | {
      type: 'connected';
      payload: {
        clientId: string;
        timestamp: number;
      };
    }
    | {
      type: 'navigation_started';
      payload: {
        sessionId: string;
        path: PathSegment[];
        firstInstruction: string;
        totalSteps: number;
        estimatedSeconds: number;
        targetHeading?: number;
      };
    }
    | {
      type: 'instruction';
      payload: {
        speech: string;
        priority: 'urgent' | 'high' | 'normal' | 'low';
        currentSegmentIndex: number;
        targetHeading?: number;
        stepsRemaining: number; // In current segment
        totalStepsRemaining: number; // For entire path
        nextAction?: string;
        confidence: number;
        // Outdoor navigation fields
        text?: string;
        distance?: number;
        maneuver?: string;
        targetBearing?: number;
        stepIndex?: number;
        totalSteps?: number;
      };
    }
    | {
      type: 'request_visual';
      payload: {
        trigger: VisualTrigger;
      };
    }
    | {
      type: 'visual_result';
      payload: {
        success: boolean;
        isOnTrack?: boolean;
        confidence?: number;
        speech: string;
        action: 'continue' | 'recalculate' | 'retry';
      };
    }
    | {
      type: 'position_update';
      payload: {
        confidence: number;
        currentRoom: string;
      };
    }
    | {
      type: 'position_ack';
      payload: {
        timestamp: number;
      };
    }
    | {
      type: 'route_update';
      payload: {
        totalDistance: number; // meters
        estimatedTime: number; // seconds
        steps: Array<{
          instruction: string;
          distance: number;
          maneuver: string;
          bearing: number;
        }>;
      };
    }
    | {
      type: 'hazard_warning';
      payload: {
        hazardType: string; // 'obstacle', 'construction', 'traffic', etc.
        severity: 'low' | 'medium' | 'high';
        distance: number;
        description: string;
        timestamp: number;
      };
    }
    | {
      type: 'arrival';
      payload: {
        message: string;
        timestamp: number;
      };
    }
    | {
      type: 'pong';
      payload: {
        timestamp: number;
      };
    }
    | {
      type: 'recalculating';
      payload: {
        reason: string;
        speech: string;
      };
    }
    | {
      type: 'navigation_complete';
      payload: {
        speech: string;
      };
    }
    | {
      type: 'navigation_cancelled';
      payload: {
        speech: string;
      };
    }
    | {
      type: 'error';
      payload: {
        code: string;
        message: string;
        speech: string;
        recoverable: boolean;
      };
    }
  );

/**
 * NavigationEngine Service
 * 
 * The main orchestrator of the navigation system. Manages navigation sessions,
 * processes sensor updates, coordinates with Vision API, and generates
 * turn-by-turn instructions for visually impaired users.
 * 
 * Responsibilities:
 * - Create and manage navigation sessions
 * - Process sensor updates (steps, compass)
 * - Decide when to request visual confirmation
 * - Call Vision API and handle results
 * - Track position and confidence using dead reckoning
 * - Persist session state to database
 */
export class NavigationEngine {
  // In-memory active sessions
  private sessions: Map<string, NavigationSessionRuntime> = new Map();

  private lastLowConfidenceVisualRequestAt: Map<string, number> = new Map();
  private readonly MIN_LOW_CONFIDENCE_VISUAL_INTERVAL_MS = 15000;

  constructor(
    private prisma: PrismaClient,
    private pathFinder: PathFinder,
    private positionTracker: PositionTracker,
    private directionTranslator: DirectionTranslator,
    private triggerEvaluator: TriggerEvaluator,
    private visionClient: VisionClient
  ) { }

  /**
   * Starts a new navigation session
   * 
   * Loads the flat map, calculates the path, creates database record,
   * and generates initial instructions.
   * 
   * @param userId - User ID starting navigation
   * @param flatMapId - Flat map ID to navigate within
   * @param destinationRoomId - Target room ID
   * @param currentRoomId - Optional starting room (defaults to first room)
   * @param currentHeading - Optional starting compass heading (defaults to 0)
   * @returns Session object and array of messages to send to client
   * 
   * @example
   * const {session, messages} = await engine.startNavigation(
   *   'user-123',
   *   'flat-456',
   *   'room-789',
   *   'room-001',
   *   0
   * );
   */
  async startNavigation(
    userId: string,
    flatMapId: string,
    destinationRoomId: string,
    currentRoomId?: string,
    currentHeading: number = 0
  ): Promise<{ session: NavigationSessionRuntime; messages: ServerMessage[] }> {
    const normalizedHeading = this.positionTracker.normalizeHeading(currentHeading);
    console.log(
      `[NavigationEngine] Starting navigation: userId=${userId}, flatMapId=${flatMapId}, destination=${destinationRoomId}, heading=${normalizedHeading}`
    );

    try {
      // Load flat map with all relations
      const flatMap = await this.loadFlatMap(flatMapId);

      // Validate flat map belongs to user
      if (flatMap.userId !== userId) {
        throw new Error('Flat map does not belong to user');
      }

      // Determine starting room
      let startRoomId = currentRoomId;
      if (!startRoomId) {
        if (!flatMap.rooms || flatMap.rooms.length === 0) {
          throw new Error('Flat map has no rooms');
        }
        startRoomId = flatMap.rooms[0].id;
      }

      // Validate starting room exists
      const startRoom = flatMap.rooms.find((r) => r.id === startRoomId);
      if (!startRoom) {
        throw new Error(`Starting room not found: ${startRoomId}`);
      }

      // Validate destination room exists
      const destRoom = flatMap.rooms.find((r) => r.id === destinationRoomId);
      if (!destRoom) {
        throw new Error(`Destination room not found: ${destinationRoomId}`);
      }

      // Calculate path
      logger.log(`[NavigationEngine] Calculating path from ${startRoomId} to ${destinationRoomId}`);

      // Collect all doorways (both directions)
      const allDoorways: Doorway[] = [];
      for (const room of flatMap.rooms) {
        if (room.doorways) {
          allDoorways.push(...room.doorways);
        }
        if (room.incomingDoorways) {
          allDoorways.push(...room.incomingDoorways);
        }
      }

      logger.log(
        `[NavigationEngine] Path inputs: rooms=${flatMap.rooms.length}, doorways=${allDoorways.length}`
      );

      // Fallback: if room includes didn't bring doorways, fetch directly via Prisma
      if (allDoorways.length === 0) {
        const dbDoorways = await this.prisma.doorway.findMany({
          where: {
            OR: [
              { fromRoom: { flatMapId } },
              { toRoom: { flatMapId } },
            ],
          },
          select: {
            id: true,
            fromRoomId: true,
            toRoomId: true,
            positionX: true,
            positionY: true,
            compassHeading: true,
            type: true,
            distanceSteps: true,
          },
        });

        allDoorways.push(...(dbDoorways as any as Doorway[]));
        logger.log(
          `[NavigationEngine] Fallback doorway fetch: doorways=${dbDoorways.length}`
        );
      }

      const path = this.pathFinder.findPath(
        flatMap.rooms,
        allDoorways,
        startRoomId,
        destinationRoomId
      );

      if (path.length === 0) {
        throw new Error('No path found (already at destination)');
      }

      // Calculate total distance and time
      const totalSteps = this.pathFinder.getTotalDistance(path);
      const estimatedSeconds = this.pathFinder.getEstimatedTime(path);

      // Create database record
      const dbSession = await this.prisma.navigationSession.create({
        data: {
          userId,
          flatMapId,
          destinationRoomId,
          status: 'confirming_start',
          pathJson: JSON.stringify(path),
          currentSegmentIndex: 0,
          currentRoomId: startRoomId,
          estimatedPositionX: startRoom.positionX,
          estimatedPositionY: startRoom.positionY,
          currentCompassHeading: normalizedHeading,
          confidence: 1.0,
          stepsTakenInSegment: 0,
          totalStepsInSegment: path[0]?.distanceSteps || 0,
          triggeredCheckpoints: '[]',
          pendingVisualRequest: false,
        },
      });

      // Create runtime session object
      const session: NavigationSessionRuntime = {
        id: dbSession.id,
        userId,
        flatMapId,
        status: 'confirming_start',
        destinationRoomId,
        path,
        currentSegmentIndex: 0,
        currentRoomId: startRoomId,
        estimatedPosition: { x: startRoom.positionX, y: startRoom.positionY },
        currentCompassHeading: normalizedHeading,
        confidence: 1.0,
        stepsTakenInSegment: 0,
        totalStepsInSegment: path[0]?.distanceSteps || 0,
        absStepsSinceLastConfirm: 0,
        triggeredCheckpoints: [],
        triggeredProximityAlerts: [],
        lastVisualConfirmAt: null,
        lastConfirmedRoomId: null,
        pendingVisualRequest: false,
        startedAt: dbSession.startedAt,
        lastUpdateAt: dbSession.lastUpdateAt,
      };

      // Store in memory
      this.sessions.set(session.id, session);

      // Generate first instruction
      const firstInstruction = this.generateCurrentInstruction(session, currentHeading);

      // Create messages
      const messages: ServerMessage[] = [
        {
          type: 'navigation_started',
          sessionId: session.id,
          timestamp: Date.now(),
          payload: {
            sessionId: session.id,
            path,
            firstInstruction,
            totalSteps,
            estimatedSeconds,
            targetHeading: path?.[0]?.compassHeading,
          },
        },
      ];

      // Create start position confirmation trigger
      const startTrigger = this.triggerEvaluator.createStartTrigger(session);
      messages.push({
        type: 'request_visual',
        payload: {
          trigger: startTrigger,
        },
      });

      logger.log(
        `[NavigationEngine] Navigation started: sessionId=${session.id}, pathSegments=${path.length}`
      );

      return { session, messages };
    } catch (error: any) {
      logger.error('[NavigationEngine] Error starting navigation:', error.message, error.stack);
      throw error;
    }
  }

  /**
   * Processes sensor update from mobile client
   * 
   * Updates position using dead reckoning, checks for segment completion,
   * evaluates visual triggers, and generates instructions.
   * 
   * @param sessionId - Active session ID
   * @param payload - Sensor data (steps, compass heading)
   * @returns Array of messages to send to client
   * 
   * @example
   * const messages = await engine.processSensorUpdate('session-123', {
   *   stepsSinceLastUpdate: 5,
   *   totalStepsInSegment: 10,
   *   compassHeading: 90,
   *   isMoving: true
   * });
   */
  async processSensorUpdate(
    sessionId: string,
    payload: SensorUpdatePayload
  ): Promise<ServerMessage[]> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return [
        this.createErrorMessage(
          sessionId,
          'Session not found',
          false
        ),
      ];
    }

    // Skip if not in active navigation state
    if (session.status !== 'navigating' && session.status !== 'confirming_start') {
      logger.log(
        `[NavigationEngine] Skipping sensor update for session ${sessionId} with status ${session.status}`
      );
      return [];
    }

    const messages: ServerMessage[] = [];

    // Store previous position for progress checking
    const previousPosition = { ...session.estimatedPosition };

    // Compute expected segment heading (used to measure net progress)
    const currentSegmentForProgress = session.path[session.currentSegmentIndex];
    const expectedHeadingForProgress = currentSegmentForProgress?.compassHeading;

    // Process step batches if provided (new format), otherwise use legacy format
    let currentRawHeading = payload.currentHeading || payload.compassHeading || session.currentCompassHeading;
    const currentHeading = this.positionTracker.normalizeHeading(currentRawHeading);

    if (payload.stepBatches && payload.stepBatches.length > 0) {
      // New batch-based processing
      const result = this.positionTracker.processStepBatches(
        session.estimatedPosition,
        payload.stepBatches
      );

      session.estimatedPosition = { x: result.x, y: result.y };

      // Log for debugging
      const net = this.positionTracker.getNetDisplacement(payload.stepBatches);
      logger.log(
        `[NavigationEngine] User ${session.userId}: +${result.totalSteps} steps, ` +
        `net displacement: ${net.distance.toFixed(1)} steps, ` +
        `position: (${result.x.toFixed(1)}, ${result.y.toFixed(1)})`
      );

      // Track absolute movement for confidence decay
      session.absStepsSinceLastConfirm += result.totalSteps;

      // Update steps taken in segment as NET progress toward expected segment heading
      if (typeof expectedHeadingForProgress === 'number') {
        let netProgress = 0;
        for (const batch of payload.stepBatches) {
          if (!batch || batch.steps <= 0) continue;

          const h = this.positionTracker.normalizeHeading(batch.heading);
          let diff = Math.abs(h - expectedHeadingForProgress);
          if (diff > 180) diff = 360 - diff;

          // Project steps onto expected heading.
          // diff=0 => +steps, diff=180 => -steps, diff=90 => ~0
          netProgress += batch.steps * Math.cos((diff * Math.PI) / 180);
        }

        session.stepsTakenInSegment += netProgress;
      } else {
        // Fallback: if no segment, behave like before
        session.stepsTakenInSegment += result.totalSteps;
      }
    } else if (payload.stepsSinceLastUpdate !== undefined) {
      // Legacy format - single step update
      session.estimatedPosition = this.positionTracker.updatePosition(
        session.estimatedPosition,
        payload.stepsSinceLastUpdate,
        payload.compassHeading || currentHeading
      );

      // Track absolute movement for confidence decay
      if (payload.stepsSinceLastUpdate > 0) {
        session.absStepsSinceLastConfirm += payload.stepsSinceLastUpdate;
      }

      // Update steps taken in segment
      if (payload.totalStepsInSegment !== undefined) {
        session.stepsTakenInSegment = payload.totalStepsInSegment;
      } else {
        if (typeof expectedHeadingForProgress === 'number') {
          const h = this.positionTracker.normalizeHeading(payload.compassHeading || currentHeading);
          let diff = Math.abs(h - expectedHeadingForProgress);
          if (diff > 180) diff = 360 - diff;
          session.stepsTakenInSegment += payload.stepsSinceLastUpdate * Math.cos((diff * Math.PI) / 180);
        } else {
          session.stepsTakenInSegment += payload.stepsSinceLastUpdate;
        }
      }
    }

    // Update session state
    session.currentCompassHeading = currentHeading;
    session.lastUpdateAt = new Date();

    // Calculate confidence decay
    const secondsSinceConfirm = session.lastVisualConfirmAt
      ? (Date.now() - session.lastVisualConfirmAt.getTime()) / 1000
      : (Date.now() - session.startedAt.getTime()) / 1000;
    const stepsSinceConfirm = session.absStepsSinceLastConfirm;

    session.confidence = this.positionTracker.calculateConfidence(
      session.confidence,
      stepsSinceConfirm,
      secondsSinceConfirm
    );

    // Check progress toward destination
    const progressStatus = this.checkProgress(session, previousPosition);
    if (progressStatus === 'wrong_way') {
      logger.log(`[NavigationEngine] Warning: User may be going wrong way`);
      // Could send a warning message here if needed
    }

    // Check if segment is complete
    if (session.stepsTakenInSegment >= session.totalStepsInSegment) {
      logger.log(
        `[NavigationEngine] Segment ${session.currentSegmentIndex} complete, advancing`
      );
      const advanceMessages = await this.advanceSegment(session);
      messages.push(...advanceMessages);
    }

    // Check for checkpoint instructions
    const checkpointMessage = this.checkCheckpoints(session, currentHeading);
    if (checkpointMessage) {
      messages.push(checkpointMessage);
    }

    // Check for visual triggers
    const visualTrigger = this.triggerEvaluator.evaluate(session);
    if (visualTrigger) {
      if (
        visualTrigger.reason === 'low_confidence' &&
        !this.canRequestLowConfidenceVisual(session.id)
      ) {
        logger.log('[NavigationEngine] Skipping low_confidence visual trigger - rate limited');
      } else {
        if (visualTrigger.reason === 'low_confidence') {
          this.lastLowConfidenceVisualRequestAt.set(session.id, Date.now());
        }

        session.pendingVisualRequest = true;
        session.status = 'awaiting_visual';
        messages.push({
          type: 'request_visual',
          payload: {
            trigger: visualTrigger,
          },
        });
        logger.log(
          `[NavigationEngine] Visual trigger: ${visualTrigger.reason} (priority: ${visualTrigger.priority})`
        );
      }
    } else {
      // Generate current instruction if no visual needed
      const instruction = this.generateCurrentInstruction(session, currentHeading);
      if (instruction) {
        const currentSegment = session.path[session.currentSegmentIndex];
        const stepsRemaining = Math.max(0, currentSegment.distanceSteps - session.stepsTakenInSegment);
        const nextSegment = session.path[session.currentSegmentIndex + 1];

        messages.push({
          type: 'instruction',
          payload: {
            speech: instruction,
            priority: 'normal',
            currentSegmentIndex: session.currentSegmentIndex,
            targetHeading: currentSegment.compassHeading,
            stepsRemaining,
            totalStepsRemaining: this.calculateTotalStepsRemaining(session),
            nextAction: nextSegment?.action,
            confidence: session.confidence,
          },
        });
      }
    }

    // Send position update
    messages.push({
      type: 'position_update',
      payload: {
        confidence: session.confidence,
        currentRoom: session.currentRoomId,
      },
    });

    // Persist session
    await this.persistSession(session);

    return messages;
  }

  /**
   * Check if user is making progress or going wrong way
   * 
   * @param session - Current navigation session
   * @param previousPosition - Position before last update
   * @returns 'on_track' | 'wrong_way' | 'stationary'
   */
  private checkProgress(
    session: NavigationSessionRuntime,
    previousPosition: { x: number; y: number }
  ): 'on_track' | 'wrong_way' | 'stationary' {
    const currentSegment = session.path[session.currentSegmentIndex];
    if (!currentSegment) {
      return 'on_track'; // No route step to compare
    }

    // Calculate target position for current segment
    // For indoor navigation, we use the target room's position
    // This is a simplified check - in practice, you'd get the target room position
    // For now, we'll check if we're moving in the general direction of the segment heading

    // Get the expected direction from the segment
    const expectedHeading = currentSegment.compassHeading;
    const currentHeading = session.currentCompassHeading;

    // Calculate heading difference (0-180 degrees)
    let headingDiff = Math.abs(currentHeading - expectedHeading);
    if (headingDiff > 180) {
      headingDiff = 360 - headingDiff;
    }

    // If heading is more than 90 degrees off, might be going wrong way
    if (headingDiff > 90) {
      // Check displacement toward a theoretical target
      // For simplicity, assume target is 100 steps ahead in the expected direction
      const targetRadians = ((90 - expectedHeading) * Math.PI) / 180;
      const targetPosition = {
        x: session.estimatedPosition.x + 100 * Math.cos(targetRadians),
        y: session.estimatedPosition.y + 100 * Math.sin(targetRadians),
      };

      const displacement = this.positionTracker.calculateDisplacementTowardTarget(
        previousPosition,
        session.estimatedPosition,
        targetPosition
      );

      // If we've moved more than 3 steps in wrong direction, warn
      if (displacement < -3) {
        return 'wrong_way';
      }
    }

    return 'on_track';
  }

  /**
   * Processes visual confirmation response from mobile client
   * 
   * Calls Vision API to validate position, updates confidence,
   * and handles off-course scenarios.
   * 
   * @param sessionId - Active session ID
   * @param payload - Visual data (current image, reference image, heading)
   * @returns Array of messages to send to client
   * 
   * @example
   * const messages = await engine.processVisualResponse('session-123', {
   *   currentImage: 'base64...',
   *   referenceImage: 'base64...',
   *   compassHeading: 90,
   *   capturedAt: Date.now()
   * });
   */
  async processVisualResponse(
    sessionId: string,
    payload: VisualResponsePayload
  ): Promise<ServerMessage[]> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return [
        this.createErrorMessage(
          sessionId,
          'Session not found',
          false
        ),
      ];
    }

    const messages: ServerMessage[] = [];

    // Clear pending request
    session.pendingVisualRequest = false;

    // Get current segment for context
    const currentSegment = session.path[session.currentSegmentIndex];
    if (!currentSegment) {
      return [
        this.createErrorMessage(
          sessionId,
          'No current segment',
          false
        ),
      ];
    }

    // Call Vision API
    console.log(`[NavigationEngine] Calling Vision API for session ${sessionId}`);
    try {
      let referenceImage = payload.referenceImage;

      // If client didn't provide a reference image, try to fetch one from DB
      if (!referenceImage || referenceImage.trim().length === 0) {
        try {
          const dbImage = await this.prisma.referenceImage.findFirst({
            where: {
              roomId: session.currentRoomId,
            },
            orderBy: {
              capturedAt: 'desc',
            },
            select: {
              imageData: true,
            },
          });

          if (dbImage?.imageData) {
            referenceImage = dbImage.imageData;
            console.log(
              `[NavigationEngine] Using reference image from DB for room ${session.currentRoomId}`
            );
          } else {
            console.warn(
              `[NavigationEngine] No reference image available (client empty, DB none) for room ${session.currentRoomId}`
            );
          }
        } catch (dbErr) {
          console.warn(`[NavigationEngine] Failed to load reference image from DB`, dbErr);
        }
      }

      const visionResult = await this.visionClient.validatePosition(
        payload.currentImage,
        referenceImage,
        {
          expectedRoom: session.currentRoomId,
          expectedLandmarks: currentSegment.expectedLandmarks,
          compassHeading: payload.compassHeading,
        }
      );

      if (visionResult.success && visionResult.isOnTrack) {
        // Success - user is on track
        console.log(
          `[NavigationEngine] Visual confirmation successful: confidence=${visionResult.confidence}`
        );

        // Reset confidence
        if (visionResult.confidence !== undefined) {
          session.confidence = this.positionTracker.resetConfidence(visionResult.confidence);
        }

        // Update confirmation tracking
        session.lastVisualConfirmAt = new Date();
        session.lastConfirmedRoomId = session.currentRoomId;
        session.absStepsSinceLastConfirm = 0;

        // Update status if was confirming start
        if (session.status === 'confirming_start') {
          session.status = 'navigating';
        } else if (session.status === 'awaiting_visual') {
          session.status = 'navigating';
        }

        // Generate next instruction
        const instruction = this.generateCurrentInstruction(session, payload.compassHeading);

        messages.push({
          type: 'visual_result',
          payload: {
            success: true,
            isOnTrack: true,
            confidence: session.confidence,
            speech: visionResult.speech || 'Position confirmed. Continue.',
            action: 'continue',
          },
        });

        if (instruction) {
          const stepsRemaining = Math.max(
            0,
            currentSegment.distanceSteps - session.stepsTakenInSegment
          );
          messages.push({
            type: 'instruction',
            payload: {
              speech: instruction,
              priority: 'normal',
              currentSegmentIndex: session.currentSegmentIndex,
              stepsRemaining,
              totalStepsRemaining: this.calculateTotalStepsRemaining(session),
              confidence: session.confidence,
            },
          });
        }
      } else if (visionResult.success && !visionResult.isOnTrack) {
        // User is off course
        console.log(`[NavigationEngine] User off course, recalculating`);
        session.status = 'recalculating';
        session.confidence = 0.3;

        messages.push({
          type: 'visual_result',
          payload: {
            success: true,
            isOnTrack: false,
            confidence: session.confidence,
            speech: visionResult.speech || "I'm not sure where you are. Let me recalculate.",
            action: 'recalculate',
          },
        });

        messages.push({
          type: 'recalculating',
          payload: {
            reason: 'off_course',
            speech: "I'm recalculating your route. Please wait.",
          },
        });

        // TODO: Attempt to identify room and recalculate path
      } else {
        // Vision API call failed
        console.log(
          `[NavigationEngine] Vision API failed, requesting retry: error=${visionResult.error || 'unknown'}`
        );
        messages.push({
          type: 'visual_result',
          payload: {
            success: false,
            speech: visionResult.speech || 'Could not process image. Please try again.',
            action: 'retry',
          },
        });
      }
    } catch (error) {
      console.error(`[NavigationEngine] Vision API error:`, error);
      messages.push({
        type: 'visual_result',
        payload: {
          success: false,
          speech: 'Error processing image. Please try again.',
          action: 'retry',
        },
      });
    }

    // Persist session
    await this.persistSession(session);

    return messages;
  }

  /**
   * Cancels an active navigation session
   * 
   * @param sessionId - Session ID to cancel
   * @returns Array of messages to send to client
   */
  async cancelNavigation(sessionId: string): Promise<ServerMessage[]> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return [
        this.createErrorMessage(
          sessionId,
          'Session not found',
          false
        ),
      ];
    }

    session.status = 'cancelled';

    // Persist and remove from memory
    await this.persistSession(session);
    this.sessions.delete(sessionId);
    this.lastLowConfidenceVisualRequestAt.delete(sessionId);

    console.log(`[NavigationEngine] Navigation cancelled: sessionId=${sessionId}`);

    return [
      {
        type: 'navigation_cancelled',
        payload: {
          speech: 'Navigation cancelled.',
        },
      },
    ];
  }

  /**
   * Pauses an active navigation session
   * 
   * @param sessionId - Session ID to pause
   * @returns Array of messages to send to client
   */
  async pauseNavigation(sessionId: string): Promise<ServerMessage[]> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return [
        this.createErrorMessage(
          sessionId,
          'Session not found',
          false
        ),
      ];
    }

    session.status = 'paused';
    await this.persistSession(session);

    console.log(`[NavigationEngine] Navigation paused: sessionId=${sessionId}`);

    return [
      {
        type: 'instruction',
        payload: {
          speech: 'Navigation paused.',
          priority: 'normal',
          currentSegmentIndex: session.currentSegmentIndex,
          stepsRemaining: 0,
          totalStepsRemaining: this.calculateTotalStepsRemaining(session),
          confidence: session.confidence,
        },
      },
    ];
  }

  /**
   * Resumes a paused navigation session
   * 
   * @param sessionId - Session ID to resume
   * @returns Array of messages to send to client
   */
  async resumeNavigation(sessionId: string): Promise<ServerMessage[]> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return [
        this.createErrorMessage(
          sessionId,
          'Session not found',
          false
        ),
      ];
    }

    session.status = 'navigating';
    await this.persistSession(session);

    // Generate current instruction
    const instruction = this.generateCurrentInstruction(
      session,
      session.currentCompassHeading
    );

    console.log(`[NavigationEngine] Navigation resumed: sessionId=${sessionId}`);

    const currentSegment = session.path[session.currentSegmentIndex];
    const stepsRemaining = Math.max(
      0,
      currentSegment.distanceSteps - session.stepsTakenInSegment
    );

    return [
      {
        type: 'instruction',
        payload: {
          speech: instruction || 'Navigation resumed. Continue forward.',
          priority: 'normal',
          currentSegmentIndex: session.currentSegmentIndex,
          stepsRemaining,
          totalStepsRemaining: this.calculateTotalStepsRemaining(session),
          confidence: session.confidence,
        },
      },
    ];
  }

  /**
   * Gets a session from memory
   * 
   * @param sessionId - Session ID
   * @returns Session object or null if not found
   */
  getSession(sessionId: string): NavigationSessionRuntime | null {
    return this.sessions.get(sessionId) || null;
  }

  /**
   * Gets a session from memory, or loads it from database if not in memory
   * 
   * @param sessionId - Session ID
   * @returns Session object or null if not found
   */
  async getSessionOrLoadFromDb(sessionId: string): Promise<NavigationSessionRuntime | null> {
    // First check memory
    const memorySession = this.sessions.get(sessionId);
    if (memorySession) {
      return memorySession;
    }

    // Load from database
    try {
      const dbSession = await this.prisma.navigationSession.findUnique({
        where: { id: sessionId },
      });

      if (!dbSession) {
        return null;
      }

      // Convert database session to runtime format
      const path: PathSegment[] = JSON.parse(dbSession.pathJson || '[]');
      const triggeredCheckpoints: string[] = JSON.parse(dbSession.triggeredCheckpoints || '[]');

      const session: NavigationSessionRuntime = {
        id: dbSession.id,
        userId: dbSession.userId,
        flatMapId: dbSession.flatMapId,
        status: dbSession.status as any,
        destinationRoomId: dbSession.destinationRoomId,
        path,
        currentSegmentIndex: dbSession.currentSegmentIndex,
        currentRoomId: dbSession.currentRoomId,
        estimatedPosition: {
          x: dbSession.estimatedPositionX,
          y: dbSession.estimatedPositionY,
        },
        currentCompassHeading: dbSession.currentCompassHeading,
        confidence: dbSession.confidence,
        stepsTakenInSegment: dbSession.stepsTakenInSegment,
        totalStepsInSegment: dbSession.totalStepsInSegment,
        absStepsSinceLastConfirm: 0,
        triggeredCheckpoints,
        triggeredProximityAlerts: (dbSession as any).triggeredProximityAlerts ? JSON.parse((dbSession as any).triggeredProximityAlerts) : [],
        lastVisualConfirmAt: dbSession.lastVisualConfirmAt,
        lastConfirmedRoomId: dbSession.lastConfirmedRoomId,
        pendingVisualRequest: dbSession.pendingVisualRequest,
        startedAt: dbSession.startedAt,
        lastUpdateAt: dbSession.lastUpdateAt,
      };

      // Store in memory for future access
      this.sessions.set(session.id, session);

      return session;
    } catch (error) {
      console.error(`[NavigationEngine] Error loading session ${sessionId} from database:`, error);
      return null;
    }
  }

  /**
   * Advances to the next segment in the path
   * 
   * @param session - Current session
   * @returns Array of messages (empty or navigation_complete)
   */
  private async advanceSegment(
    session: NavigationSessionRuntime
  ): Promise<ServerMessage[]> {
    const nextIndex = session.currentSegmentIndex + 1;

    // Check if navigation is complete (do not advance index past the end)
    if (nextIndex >= session.path.length) {
      session.status = 'completed';
      session.pendingVisualRequest = true;
      session.triggeredCheckpoints = [];
      session.triggeredProximityAlerts = [];

      await this.persistSession(session);

      console.log(`[NavigationEngine] Navigation complete: sessionId=${session.id}`);

      return [
        {
          type: 'navigation_complete',
          payload: {
            speech: 'You have reached your destination.',
          },
        },
        {
          type: 'request_visual',
          payload: {
            trigger: {
              reason: 'arrival_verification',
              priority: 'high',
              message: 'Please take a verification photo.',
              capture: {
                mode: 'tap',
                delaySeconds: 0,
                guidanceAudio: 'Hold phone forward and take a photo',
                expectedHeading: session.currentCompassHeading,
              },
              validation: {
                query: 'validate_position',
                expectedRoom: session.destinationRoomId,
                expectedLandmarks: [],
                referenceImageId: null,
              },
            },
          },
        },
      ];
    }

    session.currentSegmentIndex = nextIndex;
    session.stepsTakenInSegment = 0;
    session.triggeredCheckpoints = [];
    session.triggeredProximityAlerts = [];

    // Setup next segment
    const nextSegment = session.path[session.currentSegmentIndex];
    session.totalStepsInSegment = nextSegment.distanceSteps;
    session.currentRoomId = nextSegment.toRoomId;

    console.log(
      `[NavigationEngine] Advanced to segment ${session.currentSegmentIndex}: ${nextSegment.action}`
    );

    return [];
  }

  private canRequestLowConfidenceVisual(sessionId: string): boolean {
    const now = Date.now();
    const last = this.lastLowConfidenceVisualRequestAt.get(sessionId) || 0;
    return now - last >= this.MIN_LOW_CONFIDENCE_VISUAL_INTERVAL_MS;
  }

  /**
   * Generates current navigation instruction
   * 
   * @param session - Current session
   * @param userHeading - User's current compass heading
   * @returns Instruction text or empty string
   */
  private generateCurrentInstruction(
    session: NavigationSessionRuntime,
    userHeading: number
  ): string {
    const currentSegment = session.path[session.currentSegmentIndex];
    if (!currentSegment) {
      return '';
    }

    const stepsRemaining = Math.max(
      0,
      currentSegment.distanceSteps - session.stepsTakenInSegment
    );

    // Generate instruction using direction translator
    const instruction = this.directionTranslator.generateInstruction(
      currentSegment.action,
      currentSegment.compassHeading,
      userHeading,
      stepsRemaining,
      currentSegment.expectedLandmarks[0] // Use first landmark if available
    );

    // Append preview of next action if close to end
    if (stepsRemaining <= 3) {
      const nextSegment = session.path[session.currentSegmentIndex + 1];
      if (nextSegment) {
        const nextAction = this.directionTranslator.getTurnDirection(
          currentSegment.compassHeading,
          nextSegment.compassHeading
        );
        return `${instruction}. Then ${nextAction}.`;
      }
    }

    return instruction;
  }

  /**
   * Checks for checkpoint instructions
   * 
   * @param session - Current session
   * @param userHeading - User's current compass heading
   * @returns Instruction message or null
   */
  private checkCheckpoints(
    session: NavigationSessionRuntime,
    _userHeading: number
  ): ServerMessage | null {
    const currentSegment = session.path[session.currentSegmentIndex];
    if (!currentSegment || !currentSegment.checkpoints) {
      return null;
    }

    // Find checkpoint that should be triggered
    for (const checkpoint of currentSegment.checkpoints) {
      if (
        checkpoint.atStep <= session.stepsTakenInSegment &&
        !session.triggeredCheckpoints.includes(checkpoint.id)
      ) {
        // Mark as triggered
        session.triggeredCheckpoints.push(checkpoint.id);

        const stepsRemaining = Math.max(
          0,
          currentSegment.distanceSteps - session.stepsTakenInSegment
        );

        return {
          type: 'instruction',
          payload: {
            speech: checkpoint.message,
            priority: checkpoint.type === 'confirm' ? 'high' : 'normal',
            currentSegmentIndex: session.currentSegmentIndex,
            stepsRemaining,
            totalStepsRemaining: this.calculateTotalStepsRemaining(session),
            confidence: session.confidence,
          },
        };
      }
    }

    // Proximity alerts (Spec: 15, 10, 5 steps)
    const proximityAlert = this.checkProximityAlerts(session);
    if (proximityAlert) {
      return proximityAlert;
    }

    return null;
  }

  /**
   * Checks for proximity alerts (15, 10, 5 steps)
   */
  private checkProximityAlerts(session: NavigationSessionRuntime): ServerMessage | null {
    const currentSegment = session.path[session.currentSegmentIndex];
    if (!currentSegment) return null;

    const stepsRemaining = currentSegment.distanceSteps - session.stepsTakenInSegment;

    // We only care about turns or room changes (walk segments shouldn't spam this?)
    // Actually, the spec says "In about 15 steps, turn left". So it's about the NEXT segment's action.
    const nextSegment = session.path[session.currentSegmentIndex + 1];
    if (!nextSegment) {
      // Last segment - check for destination arrival proximity (3 steps)
      if (stepsRemaining === 3 && !session.triggeredProximityAlerts.includes('arrival_3')) {
        session.triggeredProximityAlerts.push('arrival_3');
        return {
          type: 'instruction',
          payload: {
            speech: 'Destination on your right ahead', // Placeholder, should be smart
            priority: 'normal',
            currentSegmentIndex: session.currentSegmentIndex,
            stepsRemaining: 3,
            totalStepsRemaining: 3,
            confidence: session.confidence,
          },
        };
      }
      return null;
    }

    // If next segment is a turn or room entry
    const turnAction = nextSegment.action === 'turn' ? this.directionTranslator.getTurnDirection(currentSegment.compassHeading, nextSegment.compassHeading) : 'enter the room';

    const thresholds = [15, 10, 5];
    for (const t of thresholds) {
      if (stepsRemaining <= t && !session.triggeredProximityAlerts.includes(`prox_${t}`)) {
        session.triggeredProximityAlerts.push(`prox_${t}`);

        let message = '';
        if (t === 15) message = `In about 15 steps, ${turnAction}`;
        if (t === 10) message = `10 steps, then ${turnAction}`;
        if (t === 5) message = `${turnAction.charAt(0).toUpperCase() + turnAction.slice(1)} ahead`;

        return {
          type: 'instruction',
          payload: {
            speech: message,
            priority: t === 5 ? 'high' : 'normal',
            currentSegmentIndex: session.currentSegmentIndex,
            stepsRemaining,
            totalStepsRemaining: this.calculateTotalStepsRemaining(session),
            confidence: session.confidence,
          },
        };
      }
    }

    // Urgent turn signal at 0 steps
    if (stepsRemaining <= 0 && !session.triggeredProximityAlerts.includes('prox_0')) {
      session.triggeredProximityAlerts.push('prox_0');
      const message = `${turnAction.charAt(0).toUpperCase() + turnAction.slice(1)} now`;
      return {
        type: 'instruction',
        payload: {
          speech: message,
          priority: 'urgent',
          currentSegmentIndex: session.currentSegmentIndex,
          stepsRemaining: 0,
          totalStepsRemaining: this.calculateTotalStepsRemaining(session),
          confidence: session.confidence,
        },
      };
    }

    return null;
  }

  /**
   * Calculates total steps remaining in the entire path
   */
  private calculateTotalStepsRemaining(session: NavigationSessionRuntime): number {
    const currentSegment = session.path[session.currentSegmentIndex];
    if (!currentSegment) return 0;

    const stepsInCurrent = Math.max(0, currentSegment.distanceSteps - session.stepsTakenInSegment);

    let followingSteps = 0;
    for (let i = session.currentSegmentIndex + 1; i < session.path.length; i++) {
      followingSteps += session.path[i].distanceSteps;
    }

    return stepsInCurrent + followingSteps;
  }

  /**
   * Persists session state to database
   * 
   * @param session - Session to persist
   */
  private async persistSession(session: NavigationSessionRuntime): Promise<void> {
    try {
      await this.prisma.navigationSession.update({
        where: { id: session.id },
        data: {
          status: session.status,
          pathJson: JSON.stringify(session.path),
          currentSegmentIndex: session.currentSegmentIndex,
          currentRoomId: session.currentRoomId,
          estimatedPositionX: session.estimatedPosition.x,
          estimatedPositionY: session.estimatedPosition.y,
          currentCompassHeading: session.currentCompassHeading,
          confidence: session.confidence,
          stepsTakenInSegment: session.stepsTakenInSegment,
          totalStepsInSegment: session.totalStepsInSegment,
          triggeredCheckpoints: JSON.stringify(session.triggeredCheckpoints),
          triggeredProximityAlerts: JSON.stringify(session.triggeredProximityAlerts),
          lastVisualConfirmAt: session.lastVisualConfirmAt,
          lastConfirmedRoomId: session.lastConfirmedRoomId,
          pendingVisualRequest: session.pendingVisualRequest,
          lastUpdateAt: new Date(),
          completedAt: session.status === 'completed' ? new Date() : null,
        } as any,
      });
    } catch (error: any) {
      logger.error(`[NavigationEngine] Error persisting session ${session.id}:`, error.message, error.stack);
      // Don't throw - allow navigation to continue even if persistence fails
    }
  }

  /**
   * Creates an error message
   * 
   * @param sessionId - Session ID
   * @param message - Error message
   * @param recoverable - Whether error is recoverable
   * @returns Error message object
   */
  private createErrorMessage(
    sessionId: string,
    message: string,
    recoverable: boolean
  ): ServerMessage {
    return {
      type: 'error',
      sessionId,
      timestamp: Date.now(),
      payload: {
        code: 'NAVIGATION_ERROR',
        message,
        speech: message,
        recoverable,
      },
    };
  }

  /**
   * Loads flat map with all relations from database
   * 
   * @param flatMapId - Flat map ID
   * @returns Flat map with rooms, doorways, landmarks, reference images
   */
  private async loadFlatMap(flatMapId: string): Promise<{
    id: string;
    userId: string;
    name: string;
    origin: string;
    createdAt: Date;
    updatedAt: Date;
    rooms: Array<{
      id: string;
      flatMapId: string;
      type: string;
      name: string;
      positionX: number;
      positionY: number;
      createdAt: Date;
      updatedAt: Date;
      doorways: Doorway[];
      incomingDoorways: Doorway[];
      landmarks: Array<{
        id: string;
        roomId: string;
        name: string;
        description: string | null;
        positionX: number;
        positionY: number;
        compassDirection: number | null;
      }>;
      referenceImages: Array<{
        id: string;
        roomId: string;
        locationTag: string;
        compassHeading: number;
        imageData: string;
        description: string | null;
        detectedLandmarks: string | null;
        capturedAt: Date;
      }>;
    }>;
  }> {
    const flatMap = await this.prisma.flatMap.findUnique({
      where: { id: flatMapId },
      include: {
        rooms: {
          include: {
            doorways: true,
            incomingDoorways: true,
            landmarks: true,
            referenceImages: true,
          },
        },
      },
    });

    if (!flatMap) {
      throw new Error(`Flat map not found: ${flatMapId}`);
    }

    return flatMap;
  }
}
