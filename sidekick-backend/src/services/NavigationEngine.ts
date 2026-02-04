import type { PrismaClient } from '@prisma/client';
import type {
  NavigationSessionRuntime,
  PathSegment,
} from '../models/NavigationSession';
import type { Doorway } from '../models/Doorway';
import { PathFinder } from './PathFinder';
import { PositionTracker } from './PositionTracker';
import { DirectionTranslator } from './DirectionTranslator';
import { TriggerEvaluator, type VisualTrigger } from './TriggerEvaluator';

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
    message?: string;
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
export type ServerMessage =
  | {
      type: 'connection_established';
      payload: {
        userId: string;
        clientId: string;
      };
    }
  | {
      type: 'connected';
      clientId: string;
      timestamp: number;
    }
  | {
      type: 'navigation_started';
      sessionId: string;
      path: PathSegment[];
      firstInstruction: string;
      totalSteps: number;
      estimatedSeconds: number;
    }
  | {
      type: 'instruction';
      speech: string;
      priority: 'high' | 'normal' | 'low';
      currentSegmentIndex: number;
      stepsRemaining: number;
      nextAction?: string;
      confidence: number;
      // Outdoor navigation fields
      text?: string;
      distance?: number;
      maneuver?: string;
      targetBearing?: number;
      stepIndex?: number;
      totalSteps?: number;
    }
  | {
      type: 'request_visual';
      trigger: VisualTrigger;
    }
  | {
      type: 'visual_result';
      success: boolean;
      isOnTrack?: boolean;
      confidence?: number;
      speech: string;
      action: 'continue' | 'recalculate' | 'retry';
    }
  | {
      type: 'position_update';
      confidence: number;
      currentRoom: string;
    }
  | {
      type: 'position_ack';
      timestamp: number;
    }
  | {
      type: 'route_update';
      totalDistance: number; // meters
      estimatedTime: number; // seconds
      steps: Array<{
        instruction: string;
        distance: number;
        maneuver: string;
        bearing: number;
      }>;
    }
  | {
      type: 'hazard_warning';
      hazardType: string; // 'obstacle', 'construction', 'traffic', etc.
      severity: 'low' | 'medium' | 'high';
      distance: number;
      description: string;
      timestamp: number;
    }
  | {
      type: 'arrival';
      message: string;
      timestamp: number;
    }
  | {
      type: 'pong';
      timestamp: number;
    }
  | {
      type: 'recalculating';
      reason: string;
      speech: string;
    }
  | {
      type: 'navigation_complete';
      speech: string;
    }
  | {
      type: 'navigation_cancelled';
      speech: string;
    }
  | {
      type: 'error';
      code: string;
      message: string;
      speech: string;
      recoverable: boolean;
    };

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

  constructor(
    private prisma: PrismaClient,
    private pathFinder: PathFinder,
    private positionTracker: PositionTracker,
    private directionTranslator: DirectionTranslator,
    private triggerEvaluator: TriggerEvaluator,
    private visionClient: VisionClient
  ) {}

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
    console.log(
      `[NavigationEngine] Starting navigation: userId=${userId}, flatMapId=${flatMapId}, destination=${destinationRoomId}`
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
      console.log(`[NavigationEngine] Calculating path from ${startRoomId} to ${destinationRoomId}`);
      
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
          currentCompassHeading: currentHeading,
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
        currentCompassHeading: currentHeading,
        confidence: 1.0,
        stepsTakenInSegment: 0,
        totalStepsInSegment: path[0]?.distanceSteps || 0,
        triggeredCheckpoints: [],
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
          path,
          firstInstruction,
          totalSteps,
          estimatedSeconds,
        },
      ];

      // Create start position confirmation trigger
      const startTrigger = this.triggerEvaluator.createStartTrigger(session);
      messages.push({
        type: 'request_visual',
        trigger: startTrigger,
      });

      console.log(
        `[NavigationEngine] Navigation started: sessionId=${session.id}, pathSegments=${path.length}`
      );

      return { session, messages };
    } catch (error) {
      console.error('[NavigationEngine] Error starting navigation:', error);
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
      console.log(
        `[NavigationEngine] Skipping sensor update for session ${sessionId} with status ${session.status}`
      );
      return [];
    }

    const messages: ServerMessage[] = [];

    // Store previous position for progress checking
    const previousPosition = { ...session.estimatedPosition };

    // Process step batches if provided (new format), otherwise use legacy format
    let currentHeading = payload.currentHeading || payload.compassHeading || session.currentCompassHeading;

    if (payload.stepBatches && payload.stepBatches.length > 0) {
      // New batch-based processing
      const result = this.positionTracker.processStepBatches(
        session.estimatedPosition,
        payload.stepBatches
      );

      session.estimatedPosition = { x: result.x, y: result.y };

      // Log for debugging
      const net = this.positionTracker.getNetDisplacement(payload.stepBatches);
      console.log(
        `[NavigationEngine] User ${session.userId}: +${result.totalSteps} steps, ` +
        `net displacement: ${net.distance.toFixed(1)} steps, ` +
        `position: (${result.x.toFixed(1)}, ${result.y.toFixed(1)})`
      );

      // Update steps taken in segment
      session.stepsTakenInSegment += result.totalSteps;
    } else if (payload.stepsSinceLastUpdate !== undefined) {
      // Legacy format - single step update
      session.estimatedPosition = this.positionTracker.updatePosition(
        session.estimatedPosition,
        payload.stepsSinceLastUpdate,
        payload.compassHeading || currentHeading
      );
      
      // Update steps taken in segment
      if (payload.totalStepsInSegment !== undefined) {
        session.stepsTakenInSegment = payload.totalStepsInSegment;
      } else {
        session.stepsTakenInSegment += payload.stepsSinceLastUpdate;
      }
    }

    // Update session state
    session.currentCompassHeading = currentHeading;
    session.lastUpdateAt = new Date();

    // Calculate confidence decay
    const secondsSinceConfirm = session.lastVisualConfirmAt
      ? (Date.now() - session.lastVisualConfirmAt.getTime()) / 1000
      : (Date.now() - session.startedAt.getTime()) / 1000;
    const stepsSinceConfirm = session.stepsTakenInSegment;

    session.confidence = this.positionTracker.calculateConfidence(
      session.confidence,
      stepsSinceConfirm,
      secondsSinceConfirm
    );

    // Check progress toward destination
    const progressStatus = this.checkProgress(session, previousPosition);
    if (progressStatus === 'wrong_way') {
      console.log(`[NavigationEngine] Warning: User may be going wrong way`);
      // Could send a warning message here if needed
    }

    // Check if segment is complete
    if (session.stepsTakenInSegment >= session.totalStepsInSegment) {
      console.log(
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
      session.pendingVisualRequest = true;
      session.status = 'awaiting_visual';
      messages.push({
        type: 'request_visual',
        trigger: visualTrigger,
      });
      console.log(
        `[NavigationEngine] Visual trigger: ${visualTrigger.reason} (priority: ${visualTrigger.priority})`
      );
    } else {
      // Generate current instruction if no visual needed
      const instruction = this.generateCurrentInstruction(session, currentHeading);
      if (instruction) {
        const currentSegment = session.path[session.currentSegmentIndex];
        const stepsRemaining = Math.max(0, currentSegment.distanceSteps - session.stepsTakenInSegment);
        const nextSegment = session.path[session.currentSegmentIndex + 1];

        messages.push({
          type: 'instruction',
          speech: instruction,
          priority: 'normal',
          currentSegmentIndex: session.currentSegmentIndex,
          stepsRemaining,
          nextAction: nextSegment?.action,
          confidence: session.confidence,
        });
      }
    }

    // Send position update
    messages.push({
      type: 'position_update',
      confidence: session.confidence,
      currentRoom: session.currentRoomId,
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
      const visionResult = await this.visionClient.validatePosition(
        payload.currentImage,
        payload.referenceImage,
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
          success: true,
          isOnTrack: true,
          confidence: session.confidence,
          speech: visionResult.message || 'Position confirmed. Continue.',
          action: 'continue',
        });

        if (instruction) {
          const stepsRemaining = Math.max(
            0,
            currentSegment.distanceSteps - session.stepsTakenInSegment
          );
          messages.push({
            type: 'instruction',
            speech: instruction,
            priority: 'normal',
            currentSegmentIndex: session.currentSegmentIndex,
            stepsRemaining,
            confidence: session.confidence,
          });
        }
      } else if (visionResult.success && !visionResult.isOnTrack) {
        // User is off course
        console.log(`[NavigationEngine] User off course, recalculating`);
        session.status = 'recalculating';
        session.confidence = 0.3;

        messages.push({
          type: 'visual_result',
          success: true,
          isOnTrack: false,
          confidence: session.confidence,
          speech: visionResult.message || "I'm not sure where you are. Let me recalculate.",
          action: 'recalculate',
        });

        messages.push({
          type: 'recalculating',
          reason: 'off_course',
          speech: "I'm recalculating your route. Please wait.",
        });

        // TODO: Attempt to identify room and recalculate path
      } else {
        // Vision API call failed
        console.log(`[NavigationEngine] Vision API failed, requesting retry`);
        messages.push({
          type: 'visual_result',
          success: false,
          speech: visionResult.message || 'Could not process image. Please try again.',
          action: 'retry',
        });
      }
    } catch (error) {
      console.error(`[NavigationEngine] Vision API error:`, error);
      messages.push({
        type: 'visual_result',
        success: false,
        speech: 'Error processing image. Please try again.',
        action: 'retry',
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
        speech: 'Navigation cancelled.',
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
        speech: 'Navigation paused.',
        priority: 'normal',
        currentSegmentIndex: session.currentSegmentIndex,
        stepsRemaining: 0,
        confidence: session.confidence,
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
        speech: instruction || 'Navigation resumed. Continue forward.',
        priority: 'normal',
        currentSegmentIndex: session.currentSegmentIndex,
        stepsRemaining,
        confidence: session.confidence,
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
        triggeredCheckpoints,
        lastVisualConfirmAt: dbSession.lastVisualConfirmAt,
        lastConfirmedRoomId: dbSession.lastConfirmedRoomId || null,
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
    session.currentSegmentIndex++;
    session.stepsTakenInSegment = 0;
    session.triggeredCheckpoints = [];

    // Check if navigation is complete
    if (session.currentSegmentIndex >= session.path.length) {
      session.status = 'completed';
      await this.persistSession(session);
      this.sessions.delete(session.id);

      console.log(`[NavigationEngine] Navigation complete: sessionId=${session.id}`);

      return [
        {
          type: 'navigation_complete',
          speech: 'You have reached your destination.',
        },
      ];
    }

    // Setup next segment
    const nextSegment = session.path[session.currentSegmentIndex];
    session.totalStepsInSegment = nextSegment.distanceSteps;
    session.currentRoomId = nextSegment.toRoomId;

    console.log(
      `[NavigationEngine] Advanced to segment ${session.currentSegmentIndex}: ${nextSegment.action}`
    );

    return [];
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
          speech: checkpoint.message,
          priority: checkpoint.type === 'confirm' ? 'high' : 'normal',
          currentSegmentIndex: session.currentSegmentIndex,
          stepsRemaining,
          confidence: session.confidence,
        };
      }
    }

    return null;
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
          lastVisualConfirmAt: session.lastVisualConfirmAt,
          lastConfirmedRoomId: session.lastConfirmedRoomId,
          pendingVisualRequest: session.pendingVisualRequest,
          lastUpdateAt: new Date(),
          completedAt: session.status === 'completed' ? new Date() : null,
        },
      });
    } catch (error) {
      console.error(`[NavigationEngine] Error persisting session ${session.id}:`, error);
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
    _sessionId: string,
    message: string,
    recoverable: boolean
  ): ServerMessage {
    return {
      type: 'error',
      code: 'NAVIGATION_ERROR',
      message,
      speech: message,
      recoverable,
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
