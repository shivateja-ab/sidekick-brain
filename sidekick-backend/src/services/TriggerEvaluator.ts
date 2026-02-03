import type { PathSegment } from '../models/NavigationSession';

/**
 * Reason for requesting visual confirmation
 */
export type VisualTriggerReason =
  | 'approaching_turn' // About to turn, need to confirm junction
  | 'entering_room' // About to enter new room
  | 'checkpoint' // Mandatory checkpoint in path
  | 'low_confidence' // Dead reckoning confidence dropped
  | 'time_elapsed' // Been too long since last visual check
  | 'off_course' // Previous check showed user not where expected
  | 'user_requested' // User explicitly asked "where am I"
  | 'navigation_start'; // Beginning of navigation, confirm start position

/**
 * Priority level for visual trigger
 */
export type TriggerPriority = 'urgent' | 'high' | 'normal' | 'low';

/**
 * Capture mode for camera
 */
export type CaptureMode = 'auto' | 'voice' | 'tap' | 'motion_stable';

/**
 * Visual trigger object that tells the client how to handle camera capture
 */
export interface VisualTrigger {
  reason: VisualTriggerReason;
  priority: TriggerPriority;
  message: string; // Spoken to user explaining why

  capture: {
    mode: CaptureMode;
    delaySeconds: number; // Countdown before auto-capture
    guidanceAudio: string; // Instructions like "Hold phone forward"
    expectedHeading?: number; // Optional: which direction to point camera
  };

  validation: {
    query: 'validate_position' | 'identify_room' | 'check_obstacles';
    expectedRoom: string;
    expectedLandmarks: string[];
    referenceImageId: string | null;
  };
}

/**
 * Simplified navigation session interface for trigger evaluation
 */
export interface NavigationSession {
  status: string;
  path: PathSegment[];
  currentSegmentIndex: number;
  stepsTakenInSegment: number;
  totalStepsInSegment: number;
  confidence: number;
  lastVisualConfirmAt: Date | null;
  triggeredCheckpoints: string[];
  pendingVisualRequest: boolean;
  currentRoomId: string;
}

/**
 * TriggerEvaluator Service
 * 
 * Evaluates navigation state and decides when to request visual confirmation
 * from the user. Prevents constant camera requests while ensuring critical
 * moments are captured for position validation.
 */
export class TriggerEvaluator {
  // Steps before turn to request visual confirmation
  private readonly TURN_APPROACH_STEPS = 5;

  // Steps before entering room to request visual confirmation
  private readonly ROOM_ENTER_STEPS = 3;

  // Confidence threshold below which visual confirmation is needed
  private readonly LOW_CONFIDENCE_THRESHOLD = 0.6;

  // Maximum seconds without visual confirmation before forcing a check
  private readonly MAX_SECONDS_WITHOUT_CONFIRM = 30;

  /**
   * Main evaluation method called on every sensor update
   * 
   * Checks conditions in priority order and returns the first matching trigger.
   * Returns null if no visual confirmation is needed at this time.
   * 
   * @param session - Current navigation session state
   * @returns VisualTrigger if confirmation needed, null otherwise
   * 
   * @example
   * // User approaching a turn
   * evaluate({...session, stepsTakenInSegment: 8, totalStepsInSegment: 10, ...})
   * // Returns: VisualTrigger with reason 'approaching_turn'
   * 
   * @example
   * // No trigger needed
   * evaluate({...session, stepsTakenInSegment: 2, totalStepsInSegment: 20, ...})
   * // Returns: null
   */
  evaluate(session: NavigationSession): VisualTrigger | null {
    // If already waiting for visual, don't trigger another
    if (session.pendingVisualRequest) {
      return null;
    }

    // Check conditions in priority order
    // Return first matching trigger

    // 1. Approaching turn (high priority)
    const turnTrigger = this.checkApproachingTurn(session);
    if (turnTrigger) {
      return turnTrigger;
    }

    // 2. Entering room (high priority)
    const roomTrigger = this.checkEnteringRoom(session);
    if (roomTrigger) {
      return roomTrigger;
    }

    // 3. Mandatory checkpoint (normal priority)
    const checkpointTrigger = this.checkMandatoryCheckpoint(session);
    if (checkpointTrigger) {
      return checkpointTrigger;
    }

    // 4. Low confidence (normal priority)
    const confidenceTrigger = this.checkLowConfidence(session);
    if (confidenceTrigger) {
      return confidenceTrigger;
    }

    // 5. Time elapsed (low priority)
    const timeTrigger = this.checkTimeElapsed(session);
    if (timeTrigger) {
      return timeTrigger;
    }

    // No trigger needed
    return null;
  }

  /**
   * Checks if user is approaching a turn and needs visual confirmation
   * 
   * Triggers when:
   * - Next segment has action 'turn'
   * - Steps remaining in current segment <= TURN_APPROACH_STEPS
   * 
   * @param session - Current navigation session
   * @returns VisualTrigger or null
   * 
   * @example
   * // Current segment: 8/10 steps, next segment: turn
   * checkApproachingTurn(session)
   * // Returns: VisualTrigger with reason 'approaching_turn', priority 'high'
   */
  private checkApproachingTurn(session: NavigationSession): VisualTrigger | null {
    const currentSegment = session.path[session.currentSegmentIndex];
    const nextSegment = session.path[session.currentSegmentIndex + 1];

    // Need current and next segments
    if (!currentSegment || !nextSegment || nextSegment.action !== 'turn') {
      return null;
    }

    // Check if approaching turn
    const stepsRemaining = currentSegment.distanceSteps - session.stepsTakenInSegment;
    if (stepsRemaining > this.TURN_APPROACH_STEPS) {
      return null;
    }

    // Build trigger
    const steps = Math.max(1, stepsRemaining);
    return this.buildTrigger('approaching_turn', session, {
      priority: 'high',
      message: `Turn coming up in ${steps} step${steps !== 1 ? 's' : ''}, confirming position`,
      capture: {
        mode: 'auto',
        delaySeconds: 2,
        guidanceAudio: 'Hold phone forward, pointing in the direction you are walking',
      },
    });
  }

  /**
   * Checks if user is about to enter a new room
   * 
   * Triggers when:
   * - Current segment action is 'enter_room'
   * - Steps remaining <= ROOM_ENTER_STEPS
   * 
   * @param session - Current navigation session
   * @returns VisualTrigger or null
   * 
   * @example
   * // Current segment: enter_room, 2/5 steps taken
   * checkEnteringRoom(session)
   * // Returns: VisualTrigger with reason 'entering_room', priority 'high'
   */
  private checkEnteringRoom(session: NavigationSession): VisualTrigger | null {
    const currentSegment = session.path[session.currentSegmentIndex];

    // Must be entering room segment
    if (!currentSegment || currentSegment.action !== 'enter_room') {
      return null;
    }

    // Check if approaching room entry
    const stepsRemaining = currentSegment.distanceSteps - session.stepsTakenInSegment;
    if (stepsRemaining > this.ROOM_ENTER_STEPS) {
      return null;
    }

    // Get room name from segment (would need room data, using placeholder)
    const roomName = 'the next room'; // TODO: Get actual room name from roomId

    // Build trigger
    return this.buildTrigger('entering_room', session, {
      priority: 'high',
      message: `About to enter ${roomName}, confirming`,
      capture: {
        mode: 'auto',
        delaySeconds: 2,
        guidanceAudio: 'Hold phone forward, pointing toward the doorway',
        expectedHeading: currentSegment.compassHeading,
      },
      validation: {
        query: 'validate_position',
        expectedRoom: currentSegment.toRoomId,
        expectedLandmarks: currentSegment.expectedLandmarks || [],
        referenceImageId: null,
      },
    });
  }

  /**
   * Checks if there's a mandatory checkpoint that requires visual confirmation
   * 
   * Triggers when:
   * - Current segment has a checkpoint
   * - Checkpoint's atStep <= stepsTakenInSegment
   * - Checkpoint requiresVisualConfirm is true
   * - Checkpoint ID not in triggeredCheckpoints
   * 
   * @param session - Current navigation session
   * @returns VisualTrigger or null
   * 
   * @example
   * // Checkpoint at step 10, user at step 12, not yet triggered
   * checkMandatoryCheckpoint(session)
   * // Returns: VisualTrigger with reason 'checkpoint', using checkpoint message
   */
  private checkMandatoryCheckpoint(session: NavigationSession): VisualTrigger | null {
    const currentSegment = session.path[session.currentSegmentIndex];

    if (!currentSegment || !currentSegment.checkpoints || currentSegment.checkpoints.length === 0) {
      return null;
    }

    // Find first untriggered checkpoint that requires visual confirmation
    for (const checkpoint of currentSegment.checkpoints) {
      // Check if checkpoint should be triggered
      if (
        checkpoint.atStep <= session.stepsTakenInSegment &&
        checkpoint.requiresVisualConfirm &&
        !session.triggeredCheckpoints.includes(checkpoint.id)
      ) {
        // Build trigger using checkpoint's message
        return this.buildTrigger('checkpoint', session, {
          priority: 'normal',
          message: checkpoint.message,
          capture: {
            mode: 'auto',
            delaySeconds: 3,
            guidanceAudio: 'Hold phone forward at chest level',
          },
        });
      }
    }

    return null;
  }

  /**
   * Checks if confidence has dropped below threshold
   * 
   * Triggers when:
   * - session.confidence < LOW_CONFIDENCE_THRESHOLD
   * 
   * @param session - Current navigation session
   * @returns VisualTrigger or null
   * 
   * @example
   * // Confidence dropped to 0.55
   * checkLowConfidence({...session, confidence: 0.55})
   * // Returns: VisualTrigger with reason 'low_confidence', priority 'normal'
   */
  private checkLowConfidence(session: NavigationSession): VisualTrigger | null {
    if (session.confidence >= this.LOW_CONFIDENCE_THRESHOLD) {
      return null;
    }

    return this.buildTrigger('low_confidence', session, {
      priority: 'normal',
      message: "Let me verify where you are",
      capture: {
        mode: 'auto',
        delaySeconds: 3,
        guidanceAudio: 'Hold phone forward at chest level, pointing in your walking direction',
      },
    });
  }

  /**
   * Checks if too much time has elapsed since last visual confirmation
   * 
   * Triggers when:
   * - lastVisualConfirmAt is not null (skip if null, handled by start trigger)
   * - Seconds since last confirm > MAX_SECONDS_WITHOUT_CONFIRM
   * 
   * @param session - Current navigation session
   * @returns VisualTrigger or null
   * 
   * @example
   * // 35 seconds since last visual confirm
   * checkTimeElapsed({...session, lastVisualConfirmAt: new Date(Date.now() - 35000)})
   * // Returns: VisualTrigger with reason 'time_elapsed', priority 'low'
   */
  private checkTimeElapsed(session: NavigationSession): VisualTrigger | null {
    // Skip if never confirmed (will be caught by start trigger)
    if (!session.lastVisualConfirmAt) {
      return null;
    }

    // Calculate seconds since last confirm
    const now = new Date();
    const secondsSinceConfirm = (now.getTime() - session.lastVisualConfirmAt.getTime()) / 1000;

    if (secondsSinceConfirm <= this.MAX_SECONDS_WITHOUT_CONFIRM) {
      return null;
    }

    return this.buildTrigger('time_elapsed', session, {
      priority: 'low',
      message: 'Quick position check',
      capture: {
        mode: 'auto',
        delaySeconds: 3,
        guidanceAudio: 'Hold phone forward at chest level',
      },
    });
  }

  /**
   * Creates a trigger for navigation start position confirmation
   * 
   * Always returns a trigger to confirm the user's starting position.
   * Called at the beginning of navigation.
   * 
   * @param session - Current navigation session
   * @returns VisualTrigger with reason 'navigation_start'
   * 
   * @example
   * // At navigation start
   * createStartTrigger(session)
   * // Returns: VisualTrigger with reason 'navigation_start', query 'validate_position'
   */
  createStartTrigger(session: NavigationSession): VisualTrigger {
    const currentSegment = session.path[0];
    return this.buildTrigger('navigation_start', session, {
      priority: 'normal',
      message: 'Confirming your starting position',
      capture: {
        mode: 'auto',
        delaySeconds: 3,
        guidanceAudio: 'Hold phone forward at chest level, pointing in your walking direction',
        expectedHeading: currentSegment?.compassHeading,
      },
      validation: {
        query: 'validate_position',
        expectedRoom: session.currentRoomId,
        expectedLandmarks: currentSegment?.expectedLandmarks || [],
        referenceImageId: null,
      },
    });
  }

  /**
   * Creates a trigger when user explicitly requests position check
   * 
   * Called when user says "where am I" or similar commands.
   * Faster response time (1 second delay) and may use different query type.
   * 
   * @param session - Current navigation session
   * @param command - User's command text
   * @returns VisualTrigger with reason 'user_requested'
   * 
   * @example
   * // User says "where am I"
   * createUserRequestTrigger(session, "where am I")
   * // Returns: VisualTrigger with query 'validate_position', delaySeconds: 1
   * 
   * @example
   * // User says "describe what's around me"
   * createUserRequestTrigger(session, "describe what's around me")
   * // Returns: VisualTrigger with query 'identify_room', delaySeconds: 1
   */
  createUserRequestTrigger(session: NavigationSession, command: string): VisualTrigger {
    const lowerCommand = command.toLowerCase();
    const isDescribe = lowerCommand.includes('around') || lowerCommand.includes('describe');

    const currentSegment = session.path[session.currentSegmentIndex];
    return this.buildTrigger('user_requested', session, {
      priority: 'normal',
      message: 'Checking your position',
      capture: {
        mode: 'auto',
        delaySeconds: 1, // Faster for user requests
        guidanceAudio: 'Hold phone forward at chest level',
        expectedHeading: currentSegment?.compassHeading,
      },
      validation: {
        query: isDescribe ? 'identify_room' : 'validate_position',
        expectedRoom: session.currentRoomId,
        expectedLandmarks: currentSegment?.expectedLandmarks || [],
        referenceImageId: null,
      },
    });
  }

  /**
   * Creates a trigger when previous visual check showed user is off course
   * 
   * Called when vision API returns isOnTrack: false.
   * Highest priority (urgent) to quickly identify where user actually is.
   * 
   * @param session - Current navigation session
   * @returns VisualTrigger with reason 'off_course', priority 'urgent'
   * 
   * @example
   * // Previous check showed user not where expected
   * createOffCourseTrigger(session)
   * // Returns: VisualTrigger with reason 'off_course', priority 'urgent', query 'identify_room'
   */
  createOffCourseTrigger(session: NavigationSession): VisualTrigger {
    return this.buildTrigger('off_course', session, {
      priority: 'urgent',
      message: "I'm not sure where you are. Let me take a look.",
      capture: {
        mode: 'auto',
        delaySeconds: 1, // Urgent, faster capture
        guidanceAudio: 'Hold phone forward and slowly rotate to capture surroundings',
      },
      validation: {
        query: 'identify_room', // Open-ended, figure out where they are
        expectedRoom: session.currentRoomId, // Best guess, but may be wrong
        expectedLandmarks: [],
        referenceImageId: null,
      },
    });
  }

  /**
   * Factory method that builds a complete VisualTrigger with defaults
   * 
   * @param reason - Reason for the trigger
   * @param session - Current navigation session
   * @param overrides - Optional overrides for specific fields
   * @returns Complete VisualTrigger object
   */
  private buildTrigger(
    reason: VisualTriggerReason,
    session: NavigationSession,
    overrides?: Partial<VisualTrigger>
  ): VisualTrigger {
    const currentSegment = session.path[session.currentSegmentIndex];

    // Default delay based on priority
    const priority = overrides?.priority || 'normal';
    const defaultDelay = this.getDefaultDelay(priority);

    // Default trigger structure
    const trigger: VisualTrigger = {
      reason,
      priority,
      message: overrides?.message || this.getDefaultMessage(reason, session),
      capture: {
        mode: 'auto',
        delaySeconds: overrides?.capture?.delaySeconds ?? defaultDelay,
        guidanceAudio:
          overrides?.capture?.guidanceAudio || 'Hold phone forward at chest level',
        expectedHeading: overrides?.capture?.expectedHeading || currentSegment?.compassHeading,
      },
      validation: {
        query: overrides?.validation?.query || 'validate_position',
        expectedRoom: overrides?.validation?.expectedRoom || session.currentRoomId,
        expectedLandmarks: overrides?.validation?.expectedLandmarks || currentSegment?.expectedLandmarks || [],
        referenceImageId: overrides?.validation?.referenceImageId || null,
      },
    };

    // Apply overrides (deep merge for nested objects)
    if (overrides) {
      return {
        ...trigger,
        ...overrides,
        capture: {
          ...trigger.capture,
          ...(overrides.capture || {}),
        },
        validation: {
          ...trigger.validation,
          ...(overrides.validation || {}),
        },
      };
    }

    return trigger;
  }

  /**
   * Gets default delay seconds based on priority
   * 
   * @param priority - Trigger priority
   * @returns Default delay in seconds
   */
  private getDefaultDelay(priority: TriggerPriority): number {
    switch (priority) {
      case 'urgent':
        return 1;
      case 'high':
        return 2;
      case 'normal':
        return 3;
      case 'low':
        return 3;
      default:
        return 3;
    }
  }

  /**
   * Gets default message for a trigger reason
   * 
   * @param reason - Trigger reason
   * @param session - Navigation session (for context)
   * @returns Default message string
   */
  private getDefaultMessage(reason: VisualTriggerReason, session: NavigationSession): string {
    switch (reason) {
      case 'approaching_turn': {
        const currentSegment = session.path[session.currentSegmentIndex];
        const stepsRemaining = Math.max(
          1,
          currentSegment.distanceSteps - session.stepsTakenInSegment
        );
        return `Turn coming up in ${stepsRemaining} step${stepsRemaining !== 1 ? 's' : ''}, confirming position`;
      }
      case 'entering_room':
        return 'About to enter the next room, confirming';
      case 'checkpoint':
        return 'Checkpoint reached, confirming position';
      case 'low_confidence':
        return "Let me verify where you are";
      case 'time_elapsed':
        return 'Quick position check';
      case 'off_course':
        return "I'm not sure where you are. Let me take a look.";
      case 'user_requested':
        return 'Checking your position';
      case 'navigation_start':
        return 'Confirming your starting position';
      default:
        return 'Position check needed';
    }
  }
}
