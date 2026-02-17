import type { PathSegment } from '../models/NavigationSession.js';

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
  | 'navigation_start' // Beginning of navigation, confirm start position
  | 'waypoint_verification' // Reached a waypoint, verify position before continuing
  | 'arrival_verification'; // Navigation completed, request a final verification photo

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
  evaluate(_session: NavigationSession): VisualTrigger | null {
    // Systematic proactive triggers are disabled per USER request.
    // Visual confirmation now only occurs at waypoints (via NavigationEngine.advanceSegment)
    // or when the user explicitly requests it.
    return null;
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
