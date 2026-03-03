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
      expectedFeaturePrompt?: string;
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

  // Kept for external access (websocket handlers) even though not used in this class
  public readonly triggerEvaluator: TriggerEvaluator;

  constructor(
    private prisma: PrismaClient,
    private pathFinder: PathFinder,
    private positionTracker: PositionTracker,
    private directionTranslator: DirectionTranslator,
    triggerEvaluator: TriggerEvaluator,
    private visionClient: VisionClient
  ) {
    this.triggerEvaluator = triggerEvaluator;
  }

  private isRefImageDebugEnabled(): boolean {
    return process.env.REF_IMAGE_DEBUG === '1';
  }

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

      // Collect all doorways, deduplicating by ID.
      // The DB already stores both forward (A→B) and reverse (B→A) doorways,
      // so we just need to collect unique doorways — no manual reversing needed.
      const doorwayMap = new Map<string, Doorway>();
      for (const room of flatMap.rooms) {
        if (room.doorways) {
          for (const d of room.doorways) doorwayMap.set(d.id, d);
        }
        if (room.incomingDoorways) {
          for (const d of room.incomingDoorways) doorwayMap.set(d.id, d);
        }
      }
      const allDoorways: Doorway[] = Array.from(doorwayMap.values());

      logger.log(
        `[NavigationEngine] Path inputs: rooms=${flatMap.rooms.length}, doorways=${allDoorways.length} (deduplicated)`
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

      // Log the computed path for debugging
      for (const seg of path) {
        logger.log(
          `[NavigationEngine] Segment ${seg.index}: ${seg.action} ` +
          `${seg.fromRoomId.slice(0, 8)}→${seg.toRoomId.slice(0, 8)} ` +
          `heading=${seg.compassHeading}° steps=${seg.distanceSteps}`
        );
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
          status: 'navigating',
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

      // Build reference image lookup: roomId → [{compassHeading, imageData, locationTag, actionDescription}]
      const roomRefImages = new Map<string, Array<{
        compassHeading: number;
        imageData: string;
        locationTag: string;
        actionDescription: string | null;
      }>>();
      for (const room of flatMap.rooms) {
        if (room.referenceImages && room.referenceImages.length > 0) {
          roomRefImages.set(
            room.id,
            room.referenceImages.map(img => ({
              compassHeading: img.compassHeading,
              imageData: img.imageData,
              locationTag: img.locationTag,
              actionDescription: (img as any).actionDescription,
            }))
          );
        }
      }
      logger.log(`[NavigationEngine] Loaded reference images for ${roomRefImages.size} rooms`);

      // Create runtime session object
      const session: NavigationSessionRuntime = {
        id: dbSession.id,
        userId,
        flatMapId,
        status: 'navigating',
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
        lastSpokenInstruction: '',
        lastInstructionAt: 0,
        totalRawSteps: 0,
        roomReferenceImages: roomRefImages,
      };

      // Store in memory
      this.sessions.set(session.id, session);

      // Generate first instruction
      const firstInstruction = await this.generateCurrentInstruction(session, currentHeading);

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

      // Also send an explicit instruction message so the mobile client
      // gets targetHeading for the alignment coach immediately
      if (firstInstruction && path[0]) {
        messages.push({
          type: 'instruction',
          payload: {
            speech: firstInstruction,
            priority: 'high',
            currentSegmentIndex: 0,
            targetHeading: path[0].compassHeading,
            stepsRemaining: path[0].distanceSteps,
            totalStepsRemaining: totalSteps,
            nextAction: path[1]?.action,
            confidence: 1.0,
          },
        });
      }

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
    // ── DIAGNOSTIC: log every sensor update so we can see what's arriving ──
    const batchCount = payload.stepBatches?.length || 0;
    const batchSteps = payload.stepBatches?.reduce((s, b) => s + (b?.steps || 0), 0) || 0;
    logger.log(
      `[NavigationEngine] SENSOR_UPDATE sessionId=${sessionId?.slice(0, 8)} ` +
      `batches=${batchCount} batchSteps=${batchSteps} ` +
      `stepsSinceLastUpdate=${payload.stepsSinceLastUpdate ?? 'N/A'} ` +
      `heading=${Math.round(payload.currentHeading || payload.compassHeading || 0)}°`
    );

    const session = this.sessions.get(sessionId);
    if (!session) {
      logger.log(`[NavigationEngine] ⚠ Session NOT FOUND in memory: ${sessionId}`);
      return [
        this.createErrorMessage(sessionId, 'Session not found', false),
      ];
    }

    logger.log(
      `[NavigationEngine] Session status=${session.status}, segment=${session.currentSegmentIndex}/${session.path.length}, ` +
      `stepsInSeg=${Math.round(session.stepsTakenInSegment)}/${session.totalStepsInSegment}`
    );

    // ── 1. Gate: only process in active states ──
    const activeStatuses: string[] = ['navigating', 'confirming_start', 'awaiting_visual', 'recalculating'];
    if (!activeStatuses.includes(session.status)) {
      return [];
    }

    // ── 2. Count raw steps from this update ──
    let newSteps = 0;
    if (payload.stepBatches && payload.stepBatches.length > 0) {
      for (const batch of payload.stepBatches) {
        if (batch && batch.steps > 0) newSteps += batch.steps;
      }
    } else if (payload.stepsSinceLastUpdate !== undefined && payload.stepsSinceLastUpdate > 0) {
      newSteps = payload.stepsSinceLastUpdate;
    }

    // ── 3. Update heading ──
    const currentRawHeading = payload.currentHeading || payload.compassHeading || session.currentCompassHeading;
    const currentHeading = this.positionTracker.normalizeHeading(currentRawHeading);
    session.currentCompassHeading = currentHeading;
    session.lastUpdateAt = new Date();

    // ── 4. Auto-promote to navigating if user is walking ──
    // Don't wait for Gemini — if user takes any steps, start navigating
    if (newSteps > 0 && session.status !== 'navigating') {
      logger.log(
        `[NavigationEngine] Auto-promoting ${sessionId} from ${session.status} → navigating (${newSteps} steps detected)`
      );
      session.status = 'navigating';
      session.pendingVisualRequest = false;
    }

    // If no steps, just send a position update with heading (for alignment coach)
    if (newSteps === 0) {
      const currentSegment = session.path[session.currentSegmentIndex];
      return [
        {
          type: 'position_update',
          payload: {
            confidence: session.confidence,
            currentRoom: session.currentRoomId,
          },
        },
        // Send targetHeading so mobile alignment coach works even when stationary
        ...(currentSegment ? [{
          type: 'instruction' as const,
          payload: {
            speech: '',
            priority: 'low' as const,
            currentSegmentIndex: session.currentSegmentIndex,
            targetHeading: currentSegment.compassHeading,
            stepsRemaining: Math.max(0, Math.round(currentSegment.distanceSteps - session.stepsTakenInSegment)),
            totalStepsRemaining: this.calculateTotalStepsRemaining(session),
            confidence: session.confidence,
          },
        }] : []),
      ];
    }

    // ── 5. Simple raw step counting — no cosine projection ──
    // Every step counts as 1 step of progress. Indoor compass is too noisy
    // for projection to be reliable, especially on short segments.
    session.stepsTakenInSegment += newSteps;
    session.totalRawSteps += newSteps;
    session.absStepsSinceLastConfirm += newSteps;

    logger.log(
      `[NavigationEngine] ${session.userId}: +${newSteps} steps, ` +
      `segment ${session.currentSegmentIndex}: ${Math.round(session.stepsTakenInSegment)}/${session.totalStepsInSegment}, ` +
      `heading: ${Math.round(currentHeading)}°`
    );

    const messages: ServerMessage[] = [];

    // ── 6. Check segment completion — exact step match ──
    // Use 100% of mapped steps so navigation matches the mapping experience exactly.
    let segmentJustAdvanced = false;
    const completionThreshold = Math.max(1, session.totalStepsInSegment);
    if (session.stepsTakenInSegment >= completionThreshold) {
      logger.log(
        `[NavigationEngine] Segment ${session.currentSegmentIndex} complete ` +
        `(${Math.round(session.stepsTakenInSegment)} >= ${completionThreshold}), advancing`
      );
      const advanceMessages = await this.advanceSegment(session);
      messages.push(...advanceMessages);
      segmentJustAdvanced = true;
    }

    // ── 7. Send silent position/heading update ──
    // When advanceSegment fires, it already emits the HIGH priority turn instruction.
    // We do NOT generate a second instruction here to avoid rapid double-speak.
    // Only send a silent update with stepsRemaining so the UI stays current.
    if (!segmentJustAdvanced && (session.status === 'navigating' || session.status === 'awaiting_visual')) {
      const currentSegment = session.path[session.currentSegmentIndex];
      if (currentSegment) {
        const stepsRemaining = Math.max(0, Math.round(currentSegment.distanceSteps - session.stepsTakenInSegment));

        // Silent update — no speech, just numeric state for the UI
        messages.push({
          type: 'instruction',
          payload: {
            speech: '',
            priority: 'low',
            currentSegmentIndex: session.currentSegmentIndex,
            targetHeading: currentSegment.compassHeading,
            stepsRemaining,
            totalStepsRemaining: this.calculateTotalStepsRemaining(session),
            confidence: session.confidence,
          },
        });
      }
    }

    // ── 8. Position update ──
    messages.push({
      type: 'position_update',
      payload: {
        confidence: session.confidence,
        currentRoom: session.currentRoomId,
      },
    });

    // ── 9. Proactive visual triggers ──
    // Check if we should request visual confirmation (e.g., approaching turn)
    // SKIP if we just advanced segments to give user time to hear the walk instruction
    if (session.status === 'navigating' && !session.pendingVisualRequest && !segmentJustAdvanced) {
      const trigger = this.triggerEvaluator.evaluate(session as any);
      if (trigger) {
        logger.log(`[NavigationEngine] TriggerEvaluator requested visual: reason=${trigger.reason}`);
        session.status = 'awaiting_visual';
        session.pendingVisualRequest = true;
        messages.push({
          type: 'request_visual',
          payload: { trigger },
        });
      }
    }

    // ── 10. Persist (fire-and-forget, don't block navigation) ──
    this.persistSession(session).catch(err =>
      logger.error(`[NavigationEngine] Persist error: ${err.message}`)
    );

    return messages;
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
      let expectedFeaturePrompt = '';

      if (this.isRefImageDebugEnabled()) {
        const curLen = typeof payload.currentImage === 'string' ? payload.currentImage.length : 0;
        const refLen = typeof payload.referenceImage === 'string' ? payload.referenceImage.length : 0;
        logger.log(
          `[NavigationEngine][REF_IMAGE_DEBUG] visual_response session=${sessionId} room=${session.currentRoomId} seg=${session.currentSegmentIndex} currentImageLen=${curLen} referenceImageLen=${refLen}`
        );
      }

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
              description: true,
              detectedLandmarks: true,
            },
          });

          if (dbImage?.imageData) {
            referenceImage = dbImage.imageData;

            if (this.isRefImageDebugEnabled()) {
              logger.log(
                `[NavigationEngine][REF_IMAGE_DEBUG] Loaded reference image from DB room=${session.currentRoomId} refLen=${dbImage.imageData.length}`
              );
            }

            // Construct prompt from stored analysis
            const parts = [];
            if (dbImage.description) parts.push(dbImage.description);
            if (dbImage.detectedLandmarks) {
              try {
                const landmarks = JSON.parse(dbImage.detectedLandmarks);
                if (Array.isArray(landmarks)) {
                  parts.push(`Features: ${landmarks.join(', ')}`);
                }
              } catch (e) { }
            }
            expectedFeaturePrompt = parts.join('. ');

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

      if (this.isRefImageDebugEnabled()) {
        const finalRefLen = typeof referenceImage === 'string' ? referenceImage.length : 0;
        logger.log(
          `[NavigationEngine][REF_IMAGE_DEBUG] Calling validatePosition session=${sessionId} expectedRoom=${session.currentRoomId} finalReferenceImageLen=${finalRefLen}`
        );
      }

      const visionResult = await this.visionClient.validatePosition(
        payload.currentImage,
        referenceImage,
        {
          expectedRoom: session.currentRoomId,
          expectedLandmarks: currentSegment.expectedLandmarks,
          expectedFeaturePrompt: expectedFeaturePrompt || currentSegment.instruction, // Fallback to instruction if no image analysis
          compassHeading: payload.compassHeading,
        }
      );

      if (this.isRefImageDebugEnabled()) {
        logger.log(
          `[NavigationEngine][REF_IMAGE_DEBUG] Vision result session=${sessionId} success=${visionResult.success} isOnTrack=${visionResult.isOnTrack} confidence=${visionResult.confidence}`
        );
      }

      // Heuristic: If speech is definitively positive, override isOnTrack
      if (!visionResult.isOnTrack && visionResult.success) {
        const lowerSpeech = (visionResult.speech || '').toLowerCase();
        const definitivelyPositive =
          lowerSpeech.includes('location confirmed') ||
          lowerSpeech.includes('position confirmed') ||
          lowerSpeech.includes('perfect match') ||
          lowerSpeech.includes('correctly positioned') ||
          lowerSpeech.includes('you are at') ||
          lowerSpeech.includes('exactly where you should be') ||
          lowerSpeech.includes('verified') ||
          lowerSpeech.includes('matched');

        if (definitivelyPositive && (visionResult.confidence || 0) > 0.7) {
          console.log(`[NavigationEngine] Vision speech is positive but isOnTrack=false. Overriding to TRUE.`);
          visionResult.isOnTrack = true;
          // Ensure confidence is high for the reset logic below
          visionResult.confidence = Math.max(visionResult.confidence || 0.9, 0.95);
        }
      }

      if (visionResult.success && visionResult.isOnTrack) {
        // Success - user is on track
        const confToReset = visionResult.confidence !== undefined ? visionResult.confidence : 1.0;
        console.log(
          `[NavigationEngine] Visual confirmation successful: confidence=${confToReset}`
        );

        // Reset confidence
        session.confidence = this.positionTracker.resetConfidence(confToReset);

        // Update confirmation tracking
        session.lastVisualConfirmAt = new Date();
        session.lastConfirmedRoomId = session.currentRoomId;
        session.absStepsSinceLastConfirm = 0;

        // ── Check if this was an arrival verification ──
        // Arrival: all segments walked, session was awaiting visual at the end
        const allSegmentsComplete = session.currentSegmentIndex >= session.path.length - 1
          && session.stepsTakenInSegment >= session.totalStepsInSegment;

        if (allSegmentsComplete) {
          session.status = 'completed';
          session.pendingVisualRequest = false;
          await this.persistSession(session);

          const arrival = await this.buildArrivalSpeech(session);
          logger.log(`[NavigationEngine] ✓ Arrival verified & navigation complete: sessionId=${session.id}`);

          // visual_result with minimal speech (phase transition only)
          messages.push({
            type: 'visual_result',
            payload: {
              success: true,
              isOnTrack: true,
              confidence: session.confidence,
              speech: '',
              action: 'continue',
            },
          });

          // Combine Gemini description + arrival confirmation + success into one spoken message
          const geminiDesc = visionResult.speech || '';
          const fullArrivalSpeech = geminiDesc
            ? `${geminiDesc} ${arrival.confirmSpeech} ${arrival.completeSpeech}`
            : `${arrival.confirmSpeech} ${arrival.completeSpeech}`;

          messages.push({
            type: 'navigation_complete',
            payload: {
              speech: fullArrivalSpeech,
            },
          });

          return messages;
        }

        // ── Waypoint verification or other visual check — resume navigation ──
        // Guard: we must always exit awaiting_visual after a successful confirmation.
        // Otherwise the session can get stuck and future sensor updates won't advance segments.
        if (session.status === 'confirming_start' || session.status === 'awaiting_visual') {
          session.status = 'navigating';
        }

        // === Build ONE combined spoken message for waypoint confirmation ===
        // Pattern: "Verified. [door action]. Walk 20 steps to Trashroom."

        // 1. Gemini's confirmation
        let fullSpeech = visionResult.speech || 'Verified.';

        // 2. Doorway action from AI description or doorway type
        const refImages = session.roomReferenceImages?.get(session.currentRoomId);
        let doorwayAction = '';
        if (refImages) {
          const match = refImages.find((img: { compassHeading: number; actionDescription?: string | null }) => {
            const diff = Math.abs(img.compassHeading - payload.compassHeading);
            return diff <= 45 || diff >= 315;
          });
          if (match?.actionDescription) doorwayAction = match.actionDescription;
        }
        if (!doorwayAction && currentSegment.doorwayType) {
          switch (currentSegment.doorwayType) {
            case 'door': doorwayAction = 'Open the door and go through'; break;
            case 'archway': doorwayAction = 'Go through the archway'; break;
            case 'stairs': doorwayAction = 'Take the stairs carefully'; break;
            case 'opening': doorwayAction = 'Go through the opening'; break;
          }
        }
        if (doorwayAction) fullSpeech += ` ${doorwayAction}.`;

        // 3. Simple walking direction (without repeating doorway action)
        const stepsLeft = Math.max(0, Math.round(
          currentSegment.distanceSteps - session.stepsTakenInSegment
        ));
        const clock = this.directionTranslator.compassToClock(
          currentSegment.compassHeading, payload.compassHeading
        );
        const walkDir = this.directionTranslator.clockToSpeech(clock);

        // Look up where we're heading
        let toRoomName: string | undefined;
        try {
          const toRoom = await this.prisma.room.findUnique({
            where: { id: currentSegment.toRoomId },
            select: { name: true },
          });
          if (toRoom?.name && !toRoom.name.toLowerCase().startsWith('waypoint')) {
            toRoomName = toRoom.name;
          }
        } catch { /* ignore */ }

        if (stepsLeft > 0) {
          fullSpeech += ` Walk ${walkDir}, about ${stepsLeft} step${stepsLeft !== 1 ? 's' : ''}`;
          if (toRoomName) fullSpeech += ` to ${toRoomName}`;
          fullSpeech += '.';
        } else if (toRoomName) {
          fullSpeech += ` Continue ${walkDir} to ${toRoomName}.`;
        }

        messages.push({
          type: 'visual_result',
          payload: {
            success: true,
            isOnTrack: true,
            confidence: session.confidence,
            speech: fullSpeech,
            action: 'continue',
          },
        });

        // Send a silent instruction so the UI updates stepsRemaining/targetHeading
        const stepsRemaining = Math.max(
          0,
          currentSegment.distanceSteps - session.stepsTakenInSegment
        );
        messages.push({
          type: 'instruction',
          payload: {
            speech: '',
            priority: 'low',
            currentSegmentIndex: session.currentSegmentIndex,
            targetHeading: currentSegment.compassHeading,
            stepsRemaining,
            totalStepsRemaining: this.calculateTotalStepsRemaining(session),
            confidence: session.confidence,
          },
        });

        // ── 8. Immediate Segment Advancement — check if we should move to next segment ──
        // If the user was walking during vision analysis, they might have finished this segment.
        const completionThreshold = Math.max(1, session.totalStepsInSegment);
        if (session.stepsTakenInSegment >= completionThreshold) {
          logger.log(
            `[NavigationEngine] After visual, segment ${session.currentSegmentIndex} is complete ` +
            `(${Math.round(session.stepsTakenInSegment)} >= ${completionThreshold}), advancing now.`
          );
          const advanceMessages = await this.advanceSegment(session);
          messages.push(...advanceMessages);
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
        console.log(`[NavigationEngine] User off course, staying in recalculating for now.`);
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
    const instruction = await this.generateCurrentInstruction(
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
        lastSpokenInstruction: '',
        lastInstructionAt: 0,
        totalRawSteps: 0,
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
    const messages: ServerMessage[] = [];

    // ── Navigation complete? ──
    if (nextIndex >= session.path.length) {
      // Check if destination room has reference images for arrival verification
      const destRefImages = session.roomReferenceImages?.get(session.destinationRoomId);
      if (destRefImages && destRefImages.length > 0) {
        const refImg = destRefImages[0];
        logger.log(
          `[NavigationEngine] Destination ${session.destinationRoomId} has reference image ` +
          `(heading=${refImg.compassHeading}°, tag="${refImg.locationTag}"). Requesting arrival verification.`
        );

        session.currentRoomId = session.destinationRoomId;
        session.status = 'awaiting_visual';
        session.pendingVisualRequest = true;

        // Get destination name for the spoken message
        let destName = 'your destination';
        try {
          const destRoom = await this.prisma.room.findUnique({
            where: { id: session.destinationRoomId },
            select: { name: true },
          });
          if (destRoom) destName = destRoom.name;
        } catch { /* use fallback */ }

        // Tell user to take a photo to confirm arrival
        const clockDir = this.directionTranslator.clockToSpeech(
          this.directionTranslator.compassToClock(refImg.compassHeading, session.currentCompassHeading)
        );

        messages.push({
          type: 'request_visual',
          payload: {
            trigger: {
              reason: 'arrival_verification',
              priority: 'high',
              message: `You should be at ${destName}. Please point your camera ${clockDir} and take a photo so I can confirm.`,
              capture: {
                mode: 'tap' as const,
                delaySeconds: 0,
                guidanceAudio: `Point your camera ${clockDir}`,
                expectedHeading: refImg.compassHeading,
              },
              validation: {
                query: 'validate_position' as const,
                expectedRoom: session.destinationRoomId,
                expectedLandmarks: [],
                referenceImageId: null,
              },
            },
          },
        });

        // Persist state change before waiting for visual
        await this.persistSession(session);

        return messages;
      }

      // No reference image — complete with descriptive arrival
      session.status = 'completed';
      session.pendingVisualRequest = false;
      await this.persistSession(session);

      const arrival = await this.buildArrivalSpeech(session);
      logger.log(`[NavigationEngine] ✓ Navigation complete: sessionId=${session.id}`);

      // Single message combining confirmation + success so speech doesn't get cut off
      return [
        {
          type: 'navigation_complete',
          payload: {
            speech: `${arrival.confirmSpeech} ${arrival.completeSpeech}`,
          },
        },
      ];
    }

    // ── Advance to next segment ──
    const nextSegment = session.path[nextIndex];

    session.currentSegmentIndex = nextIndex;
    session.stepsTakenInSegment = 0;
    session.totalStepsInSegment = nextSegment.distanceSteps;
    session.currentRoomId = nextSegment.fromRoomId;
    session.triggeredCheckpoints = [];
    session.triggeredProximityAlerts = [];

    // Check if the waypoint we just arrived at has reference images (door, stairs, etc.)
    // The "current" room after advancing is the segment's fromRoomId (the waypoint we reached)
    const waypointRoomId = nextSegment.fromRoomId;
    const waypointRefImages = session.roomReferenceImages?.get(waypointRoomId);

    if (waypointRefImages && waypointRefImages.length > 0) {
      const refImg = waypointRefImages[0];
      logger.log(
        `[NavigationEngine] Waypoint ${waypointRoomId.slice(0, 8)} has reference image ` +
        `(heading=${refImg.compassHeading}°, tag="${refImg.locationTag}"). Requesting verification.`
      );

      session.status = 'awaiting_visual';
      session.pendingVisualRequest = true;

      // Build a descriptive waypoint message
      const waypointName = await this.getRoomName(waypointRoomId);
      const clockDir = this.directionTranslator.clockToSpeech(
        this.directionTranslator.compassToClock(refImg.compassHeading, session.currentCompassHeading)
      );

      // Describe what they should see at this waypoint
      let waypointDesc = `You've reached ${waypointName}.`;
      if (nextSegment.doorwayType === 'door') {
        waypointDesc = `You should be at a door near ${waypointName}.`;
      } else if (nextSegment.doorwayType === 'archway') {
        waypointDesc = `You should be at an archway near ${waypointName}.`;
      } else if (nextSegment.doorwayType === 'stairs') {
        waypointDesc = `You should be at the stairs near ${waypointName}.`;
      }

      messages.push({
        type: 'request_visual',
        payload: {
          trigger: {
            reason: 'waypoint_verification',
            priority: 'high',
            message: `${waypointDesc} Please point your camera ${clockDir} to verify.`,
            capture: {
              mode: 'tap' as const,
              delaySeconds: 0,
              guidanceAudio: `Point your camera ${clockDir}`,
              expectedHeading: refImg.compassHeading,
            },
            validation: {
              query: 'validate_position' as const,
              expectedRoom: waypointRoomId,
              expectedLandmarks: [],
              referenceImageId: null,
            },
          },
        },
      });

      // Persist state change (index advanced) before waiting for visual
      await this.persistSession(session);

      return messages;
    }

    // No reference image at waypoint — give a rich turn instruction
    const toRoomName = await this.getRoomName(nextSegment.toRoomId);
    const actionDesc = this.getActionDescForRoom(session, waypointRoomId);
    const isDestination = nextSegment.toRoomId === session.destinationRoomId;

    const turnInstruction = this.directionTranslator.generateInstruction(
      nextSegment.action,
      nextSegment.compassHeading,
      session.currentCompassHeading,
      nextSegment.distanceSteps,
      nextSegment.expectedLandmarks?.[0],
      nextSegment.expectedLandmarks,
      {
        doorwayType: nextSegment.doorwayType,
        actionDescription: actionDesc,
        toRoomName,
        isDestination,
      }
    );

    // Update dedup tracker so we don't immediately repeat this
    session.lastSpokenInstruction = turnInstruction;
    session.lastInstructionAt = Date.now();

    logger.log(
      `[NavigationEngine] Advanced to segment ${nextIndex}/${session.path.length - 1}: ` +
      `"${turnInstruction}" (heading=${nextSegment.compassHeading}°, steps=${nextSegment.distanceSteps})`
    );

    // Emit the turn instruction with URGENT priority so it's always spoken and bypasses delays
    messages.push({
      type: 'instruction',
      payload: {
        speech: turnInstruction,
        priority: 'urgent',
        currentSegmentIndex: session.currentSegmentIndex,
        targetHeading: nextSegment.compassHeading,
        stepsRemaining: nextSegment.distanceSteps,
        totalStepsRemaining: this.calculateTotalStepsRemaining(session),
        nextAction: session.path[nextIndex + 1]?.action,
        confidence: session.confidence,
      },
    });

    return messages;
  }

  /**
   * Looks up a room name from DB. Used for richer speech.
   */
  private async getRoomName(roomId: string): Promise<string> {
    try {
      const room = await this.prisma.room.findUnique({
        where: { id: roomId },
        select: { name: true },
      });
      return room?.name || 'the next area';
    } catch {
      return 'the next area';
    }
  }

  /**
   * Gets action description from reference images for a room.
   */
  private getActionDescForRoom(session: NavigationSessionRuntime, roomId: string): string | undefined {
    const refImages = session.roomReferenceImages?.get(roomId);
    if (!refImages || refImages.length === 0) return undefined;
    // Pick first image with an actionDescription
    for (const img of refImages) {
      if (img.actionDescription) return img.actionDescription;
    }
    return undefined;
  }

  /**
   * Public wrapper for building arrival speech.
   * Called by WebSocket handlers when visual is skipped at destination.
   */
  async getArrivalSpeech(sessionId: string): Promise<string> {
    const session = this.sessions.get(sessionId);
    if (!session) return 'You have reached your destination.';
    const arrival = await this.buildArrivalSpeech(session);
    return `${arrival.confirmSpeech} ${arrival.completeSpeech}`;
  }

  /**
   * Builds a descriptive arrival speech using destination room features.
   * Combines room name, type, landmarks, and reference image descriptions
   * into a natural spoken confirmation.
   */
  private async buildArrivalSpeech(
    session: NavigationSessionRuntime
  ): Promise<{ confirmSpeech: string; completeSpeech: string }> {
    const destRoomId = session.destinationRoomId;

    // Fetch destination room details from DB
    let roomName = 'your destination';
    let roomType = '';
    const features: string[] = [];

    try {
      const room = await this.prisma.room.findUnique({
        where: { id: destRoomId },
        select: {
          name: true,
          type: true,
          landmarks: { select: { name: true, description: true } },
          referenceImages: {
            select: { description: true, detectedLandmarks: true },
            orderBy: { capturedAt: 'desc' },
            take: 1,
          },
        },
      });

      if (room) {
        roomName = room.name;
        roomType = room.type;

        // Gather landmark names
        if (room.landmarks && room.landmarks.length > 0) {
          for (const lm of room.landmarks) {
            if (lm.name) features.push(lm.name);
          }
        }

        // Gather features from reference image analysis
        if (room.referenceImages && room.referenceImages.length > 0) {
          const refImg = room.referenceImages[0];
          if (refImg.detectedLandmarks) {
            try {
              const parsed = JSON.parse(refImg.detectedLandmarks);
              if (Array.isArray(parsed)) {
                for (const f of parsed) {
                  if (typeof f === 'string' && !features.includes(f)) features.push(f);
                }
              }
            } catch { /* ignore */ }
          }
          if (refImg.description && features.length === 0) {
            features.push(refImg.description);
          }
        }
      }
    } catch (err) {
      logger.warn(`[NavigationEngine] Could not load destination room details: ${err}`);
    }

    // Build the feature description
    const uniqueFeatures = [...new Set(features)].slice(0, 3);
    let featureDesc = '';
    if (uniqueFeatures.length > 0) {
      featureDesc = `, I can see ${uniqueFeatures.join(', ')}`;
    }

    // Build spatial orientation — where is the destination relative to user?
    let spatialHint = '';
    const lastSegment = session.path[session.path.length - 1];
    if (lastSegment) {
      const clock = this.directionTranslator.compassToClock(
        lastSegment.compassHeading,
        session.currentCompassHeading
      );
      const dirSpeech = this.directionTranslator.clockToSpeech(clock);
      spatialHint = `. ${roomName} is ${dirSpeech}`;
    }

    // Build doorway context
    let doorwayHint = '';
    if (lastSegment?.doorwayType) {
      switch (lastSegment.doorwayType) {
        case 'door': doorwayHint = ' through the door'; break;
        case 'archway': doorwayHint = ' through the archway'; break;
        case 'opening': doorwayHint = ' through the opening'; break;
      }
    }

    // Confirmation speech
    const confirmSpeech = `Confirmed${spatialHint}${doorwayHint}${featureDesc}.`;

    // Completion speech
    const completeSpeech = `You have successfully reached ${roomName}. Navigation complete.`;

    return { confirmSpeech, completeSpeech };
  }

  /**
   * Generates current navigation instruction for the active segment.
   * Uses stepsRemaining (integer) so the speech text changes as user walks,
   * enabling the dedup logic in processSensorUpdate to detect changes.
   */
  private async generateCurrentInstruction(
    session: NavigationSessionRuntime,
    userHeading: number
  ): Promise<string> {
    const currentSegment = session.path[session.currentSegmentIndex];
    if (!currentSegment) {
      return '';
    }

    const stepsRemaining = Math.max(
      0,
      Math.round(currentSegment.distanceSteps - session.stepsTakenInSegment)
    );

    // Build context for richer instructions
    const actionDesc = this.getActionDescForRoom(session, currentSegment.fromRoomId);
    const isDestination = currentSegment.toRoomId === session.destinationRoomId;

    // Look up destination room name for the instruction
    let toRoomName: string | undefined;
    try {
      const toRoom = await this.prisma.room.findUnique({
        where: { id: currentSegment.toRoomId },
        select: { name: true },
      });
      // Skip generic names like "Waypoint 1" — not useful in speech
      if (toRoom?.name && !toRoom.name.toLowerCase().startsWith('waypoint')) {
        toRoomName = toRoom.name;
      }
    } catch { /* ignore */ }

    const instruction = this.directionTranslator.generateInstruction(
      currentSegment.action,
      currentSegment.compassHeading,
      userHeading,
      stepsRemaining,
      currentSegment.expectedLandmarks[0],
      currentSegment.expectedLandmarks,
      {
        doorwayType: currentSegment.doorwayType,
        actionDescription: actionDesc,
        toRoomName,
        isDestination,
      }
    );

    // Append preview of next action if close to end of segment
    if (stepsRemaining <= 2) {
      const nextSegment = session.path[session.currentSegmentIndex + 1];
      if (nextSegment) {
        const nextAction = this.directionTranslator.getTurnDirection(
          currentSegment.compassHeading,
          nextSegment.compassHeading
        );
        return `${instruction}. Then ${nextAction}.`;
      } else {
        return `${instruction}. Almost there.`;
      }
    }

    return instruction;
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
