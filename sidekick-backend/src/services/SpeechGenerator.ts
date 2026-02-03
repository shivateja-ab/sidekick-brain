import type { DirectionTranslator } from './DirectionTranslator';

/**
 * Speech generation options
 */
export interface SpeechOptions {
  verbosity: 'brief' | 'normal' | 'detailed';
  includeEncouragement: boolean; // "You're doing great!"
  speakDistance: boolean; // Include step counts
}

/**
 * SpeechGenerator Service
 * 
 * Generates natural, accessible speech output optimized for Text-to-Speech (TTS)
 * for visually impaired users. Follows accessibility principles:
 * - Concise and clear
 * - Most important info first
 * - Consistent patterns
 * - No visual references
 * - Spatial audio language (clock positions, left/right, steps)
 * - Avoid numbers when possible
 * 
 * @example
 * const generator = new SpeechGenerator(directionTranslator, {
 *   verbosity: 'normal',
 *   includeEncouragement: true
 * });
 * const speech = generator.instruction('walk', 'straight ahead', 10);
 * // Returns: "Walk straight ahead, about 10 steps"
 */
export class SpeechGenerator {
  private options: SpeechOptions;

  // Phrase variations to avoid repetition
  private readonly confirmations = ['Got it', 'Confirmed', 'Okay', 'Perfect', 'Looks good'];
  private readonly encouragements = [
    "You're doing great",
    'Keep going',
    'Almost there',
    'Nice work',
    'Great job',
  ];
  private readonly transitions = ['Now', 'Next', 'Then', 'After that'];
  private readonly arrivalPhrases = [
    "You've arrived at",
    "You're here. This is",
    'Destination reached. Welcome to',
  ];

  constructor(
    private directionTranslator: DirectionTranslator,
    defaultOptions?: Partial<SpeechOptions>
  ) {
    this.options = {
      verbosity: 'normal',
      includeEncouragement: false,
      speakDistance: true,
      ...defaultOptions,
    };
  }

  /**
   * Updates speech options
   * 
   * @param options - Partial options to update
   */
  setOptions(options: Partial<SpeechOptions>): void {
    this.options = { ...this.options, ...options };
  }

  /**
   * Generates opening message when navigation begins
   * 
   * @param destinationName - Name of destination room
   * @param totalSteps - Total steps in route
   * @param estimatedSeconds - Estimated time in seconds
   * @returns Opening speech message
   * 
   * @example
   * navigationStarted("Master Bedroom", 50, 40)
   * // Brief: "Taking you to Master Bedroom."
   * // Normal: "Taking you to Master Bedroom. About 50 steps, roughly 40 seconds."
   * // Detailed: "Starting navigation to Master Bedroom. The route is approximately 50 steps, which should take about 40 seconds. I'll guide you step by step."
   */
  navigationStarted(
    destinationName: string,
    totalSteps: number,
    estimatedSeconds: number
  ): string {
    if (this.options.verbosity === 'brief') {
      return `Taking you to ${destinationName}.`;
    }

    if (this.options.verbosity === 'detailed') {
      const timeStr = this.formatTime(estimatedSeconds);
      return `Starting navigation to ${destinationName}. The route is approximately ${totalSteps} steps, which should take about ${timeStr}. I'll guide you step by step.`;
    }

    // Normal verbosity
    const timeStr = this.formatTime(estimatedSeconds);
    return `Taking you to ${destinationName}. About ${totalSteps} steps, roughly ${timeStr}.`;
  }

  /**
   * Generates turn-by-turn navigation instruction
   * 
   * @param action - Navigation action type
   * @param direction - Direction from DirectionTranslator (e.g., "on your right")
   * @param steps - Number of steps
   * @param landmark - Optional landmark reference
   * @param nextAction - Optional preview of next action
   * @returns Instruction speech
   * 
   * @example
   * instruction('walk', 'straight ahead', 10)
   * // Brief: "10 steps, straight ahead"
   * // Normal: "Walk straight ahead, about 10 steps"
   * 
   * @example
   * instruction('walk', 'on your right', 5, 'window')
   * // Normal: "Walk on your right toward the window, about 5 steps"
   * 
   * @example
   * instruction('turn', 'to your left', 0)
   * // Normal: "Turn to your left"
   */
  instruction(
    action: 'walk' | 'turn' | 'exit_room' | 'enter_room' | 'climb_stairs' | 'descend_stairs',
    direction: string,
    steps: number,
    landmark?: string,
    nextAction?: string
  ): string {
    if (this.options.verbosity === 'brief') {
      if (action === 'walk') {
        return this.options.speakDistance
          ? `${steps} steps, ${direction}`
          : direction;
      }
      if (action === 'turn') {
        return `Turn ${direction}`;
      }
      if (action === 'exit_room') {
        return `Exit ${direction}`;
      }
      if (action === 'enter_room') {
        return `Enter ${direction}`;
      }
      if (action === 'climb_stairs') {
        return `Stairs up ${direction}`;
      }
      if (action === 'descend_stairs') {
        return `Stairs down ${direction}`;
      }
    }

    if (this.options.verbosity === 'detailed') {
      let instruction = '';
      const stepsStr = this.options.speakDistance ? this.formatSteps(steps) : '';

      if (action === 'walk') {
        instruction = `Walk ${direction}`;
        if (landmark) {
          instruction += ` toward the ${landmark}`;
        }
        if (stepsStr) {
          instruction += `, approximately ${stepsStr}`;
        }
        if (nextAction) {
          instruction += `. ${nextAction}`;
        }
      } else if (action === 'turn') {
        instruction = `Turn ${direction}`;
      } else if (action === 'exit_room') {
        instruction = `Go through the door ${direction}`;
      } else if (action === 'enter_room') {
        instruction = `Enter the room ${direction}`;
      } else if (action === 'climb_stairs') {
        instruction = `Stairs going up ${direction}${stepsStr ? `, ${stepsStr}` : ''}`;
      } else if (action === 'descend_stairs') {
        instruction = `Stairs going down ${direction}${stepsStr ? `, ${stepsStr}` : ''}`;
      }

      return instruction;
    }

    // Normal verbosity
    if (action === 'walk') {
      let instruction = `Walk ${direction}`;
      if (landmark) {
        instruction += ` toward the ${landmark}`;
      }
      if (this.options.speakDistance && steps > 0) {
        instruction += `, about ${this.formatSteps(steps)}`;
      }
      if (nextAction) {
        instruction += `, then ${nextAction}`;
      }
      return instruction;
    }

    if (action === 'turn') {
      return `Turn ${direction}`;
    }

    if (action === 'exit_room') {
      return `Go through the door ${direction}`;
    }

    if (action === 'enter_room') {
      return `Enter the room ${direction}`;
    }

    if (action === 'climb_stairs') {
      const stepsStr = this.options.speakDistance ? `, ${this.formatSteps(steps)}` : '';
      return `Stairs going up ${direction}${stepsStr}`;
    }

    if (action === 'descend_stairs') {
      const stepsStr = this.options.speakDistance ? `, ${this.formatSteps(steps)}` : '';
      return `Stairs going down ${direction}${stepsStr}`;
    }

    return '';
  }

  /**
   * Warning message before a turn
   * 
   * @param stepsRemaining - Steps until turn
   * @param turnDirection - Direction of turn
   * @returns Warning speech
   * 
   * @example
   * approachingTurn(5, "turn left")
   * // Brief: "5, then turn left"
   * // Normal: "5 more steps, then turn left"
   * // Detailed: "In about 5 steps, you'll need to turn left. I'll let you know when."
   */
  approachingTurn(stepsRemaining: number, turnDirection: string): string {
    if (this.options.verbosity === 'brief') {
      return `${stepsRemaining}, then ${turnDirection}`;
    }

    if (this.options.verbosity === 'detailed') {
      return `In about ${stepsRemaining} steps, you'll need to ${turnDirection}. I'll let you know when.`;
    }

    // Normal
    return `${stepsRemaining} more steps, then ${turnDirection}`;
  }

  /**
   * Checkpoint announcement
   * 
   * @param message - Checkpoint message
   * @param stepsRemaining - Steps remaining in segment
   * @returns Checkpoint speech
   * 
   * @example
   * checkpointReached("You're about halfway through this segment", 10)
   * // Returns: "You're about halfway through this segment. 10 steps to go."
   */
  checkpointReached(message: string, stepsRemaining: number): string {
    if (this.options.speakDistance && stepsRemaining > 0) {
      return `${message}. ${stepsRemaining} steps to go.`;
    }
    return message;
  }

  /**
   * Request user to show camera for visual confirmation
   * 
   * @param reason - Reason for visual check
   * @param guidance - Guidance instructions
   * @returns Request speech
   * 
   * @example
   * visualConfirmationRequest("Turn coming up", "Hold phone forward")
   * // Brief: "Turn coming up. Hold phone forward."
   * // Normal: "Turn coming up. Hold phone forward. I'll capture automatically."
   * // Detailed: "Turn coming up. Please hold phone forward. Hold steady and I'll take a picture automatically in a few seconds."
   */
  visualConfirmationRequest(reason: string, guidance: string): string {
    if (this.options.verbosity === 'brief') {
      return `${reason}. ${guidance}.`;
    }

    if (this.options.verbosity === 'detailed') {
      return `${reason}. Please ${guidance.toLowerCase()}. Hold steady and I'll take a picture automatically in a few seconds.`;
    }

    // Normal
    return `${reason}. ${guidance}. I'll capture automatically.`;
  }

  /**
   * Positive confirmation after successful visual check
   * 
   * @param additionalInfo - Optional additional information
   * @returns Confirmation speech
   * 
   * @example
   * visualConfirmationSuccess()
   * // Returns: "Got it, you're on track." (varies)
   * 
   * @example
   * visualConfirmationSuccess("Continue forward")
   * // Returns: "Perfect, continuing. Continue forward."
   */
  visualConfirmationSuccess(additionalInfo?: string): string {
    const confirmation = this.randomChoice(this.confirmations);
    let speech = '';

    if (confirmation === 'Got it') {
      speech = "Got it, you're on track.";
    } else if (confirmation === 'Confirmed') {
      speech = 'Confirmed.';
    } else if (confirmation === 'Perfect') {
      speech = 'Perfect, continuing.';
    } else if (confirmation === 'Looks good') {
      speech = 'Looks good.';
    } else {
      speech = `${confirmation}.`;
    }

    if (additionalInfo) {
      speech += ` ${additionalInfo}`;
    }

    return speech;
  }

  /**
   * When visual check shows user is off course
   * 
   * @param reason - Why the check failed
   * @param nextStep - What happens next
   * @returns Reassuring speech
   * 
   * @example
   * visualConfirmationFailed("this doesn't match the expected room", "Let me recalculate")
   * // Returns: "Hmm, this doesn't look quite right. This doesn't match the expected room. Let me recalculate."
   */
  visualConfirmationFailed(reason: string, nextStep: string): string {
    return `Hmm, this doesn't look quite right. ${reason}. ${nextStep}`;
  }

  /**
   * Arrival announcement when destination is reached
   * 
   * @param destinationName - Name of destination
   * @returns Arrival speech
   * 
   * @example
   * navigationComplete("Master Bedroom")
   * // Returns: "You've arrived at the Master Bedroom." (varies)
   * 
   * @example
   * // With encouragement enabled
   * // Returns: "You've arrived at the Master Bedroom. Great job!"
   */
  navigationComplete(destinationName: string): string {
    const phrase = this.randomChoice(this.arrivalPhrases);
    let speech = `${phrase} the ${destinationName}.`;

    if (this.options.includeEncouragement) {
      const encouragement = this.randomChoice(this.encouragements);
      speech += ` ${encouragement}!`;
    }

    return speech;
  }

  /**
   * Cancellation confirmation
   * 
   * @returns Cancellation speech
   * 
   * @example
   * navigationCancelled()
   * // Returns: "Navigation cancelled."
   */
  navigationCancelled(): string {
    return 'Navigation cancelled.';
  }

  /**
   * Error message that doesn't sound technical
   * 
   * @param userFriendlyMessage - User-friendly error message
   * @param canRetry - Whether user can retry
   * @returns Error speech
   * 
   * @example
   * error("Could not process image", true)
   * // Returns: "Could not process image. Let's try again."
   * 
   * @example
   * error("Session not found", false)
   * // Returns: "Session not found."
   */
  error(userFriendlyMessage: string, canRetry: boolean): string {
    if (canRetry) {
      return `${userFriendlyMessage}. Let's try again.`;
    }
    return `${userFriendlyMessage}.`;
  }

  /**
   * When position confidence is low
   * 
   * @returns Uncertainty speech
   * 
   * @example
   * positionUncertain()
   * // Returns: "I'm not entirely sure where we are. Let me check."
   */
  positionUncertain(): string {
    return "I'm not entirely sure where we are. Let me check.";
  }

  /**
   * When recalculating route
   * 
   * @param reason - Optional reason for recalculation
   * @returns Recalculation speech
   * 
   * @example
   * recalculating()
   * // Returns: "Finding a new route." (varies)
   * 
   * @example
   * recalculating("off course")
   * // Returns: "You're off course. Finding a new route."
   */
  recalculating(reason?: string): string {
    const phrases = ['Finding a new route.', 'Recalculating.', "Let me find another way."];
    const phrase = this.randomChoice(phrases);

    if (reason) {
      return `You're ${reason}. ${phrase}`;
    }

    return phrase;
  }

  /**
   * Obstacle warning
   * 
   * @param type - Type of obstacle (e.g., "stairs", "person", "door")
   * @param position - Position relative to user (e.g., "directly ahead", "on your left")
   * @param distance - Distance description (e.g., "close", "ahead")
   * @param urgent - Whether obstacle requires immediate attention
   * @returns Obstacle warning speech
   * 
   * @example
   * obstacle("stairs", "directly ahead", "close", true)
   * // Returns: "Stop! Stairs directly ahead."
   * 
   * @example
   * obstacle("person", "on your left", "close", false)
   * // Returns: "Careful, person on your left, close."
   * 
   * @example
   * obstacle("door", "on your right", "ahead", false)
   * // Returns: "Door ahead on your right."
   */
  obstacle(type: string, position: string, distance: string, urgent: boolean): string {
    if (urgent) {
      return `Stop! ${type.charAt(0).toUpperCase() + type.slice(1)} ${position}.`;
    }

    if (distance === 'close' || distance.includes('close')) {
      return `Careful, ${type} ${position}, ${distance}.`;
    }

    return `${type.charAt(0).toUpperCase() + type.slice(1)} ahead ${position}.`;
  }

  /**
   * Converts step count to natural language
   * 
   * @param steps - Number of steps
   * @returns Natural language step description
   * 
   * @example
   * formatSteps(2)
   * // Returns: "a couple of steps"
   * 
   * @example
   * formatSteps(5)
   * // Returns: "a few steps"
   * 
   * @example
   * formatSteps(8)
   * // Returns: "about 8 steps"
   * 
   * @example
   * formatSteps(15)
   * // Returns: "15 steps"
   * 
   * @private
   */
  private formatSteps(steps: number): string {
    if (this.options.verbosity === 'detailed') {
      // In detailed mode, always use exact numbers
      return `${steps} steps`;
    }

    if (steps <= 2) {
      return 'a couple of steps';
    }

    if (steps <= 5) {
      return 'a few steps';
    }

    if (steps <= 10) {
      return `about ${steps} steps`;
    }

    return `${steps} steps`;
  }

  /**
   * Converts seconds to natural time description
   * 
   * @param seconds - Number of seconds
   * @returns Natural language time description
   * 
   * @example
   * formatTime(30)
   * // Returns: "30 seconds"
   * 
   * @example
   * formatTime(75)
   * // Returns: "about a minute"
   * 
   * @example
   * formatTime(105)
   * // Returns: "a minute and a half"
   * 
   * @example
   * formatTime(150)
   * // Returns: "2 minutes"
   * 
   * @private
   */
  private formatTime(seconds: number): string {
    if (seconds < 60) {
      return `${seconds} second${seconds !== 1 ? 's' : ''}`;
    }

    if (seconds <= 90) {
      return 'about a minute';
    }

    if (seconds <= 120) {
      return 'a minute and a half';
    }

    const minutes = Math.round(seconds / 60);
    return `${minutes} minute${minutes !== 1 ? 's' : ''}`;
  }

  /**
   * Randomly selects an item from an array
   * 
   * @param options - Array of options
   * @returns Randomly selected item
   * 
   * @private
   */
  private randomChoice<T>(options: T[]): T {
    if (options.length === 0) {
      throw new Error('Cannot choose from empty array');
    }
    return options[Math.floor(Math.random() * options.length)];
  }
}
