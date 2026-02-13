/**
 * DirectionTranslator Service
 * 
 * Converts absolute compass directions (0-360°) to user-relative clock positions (1-12)
 * and generates natural language navigation instructions for visually impaired users.
 * 
 * Compass conventions:
 * - 0° = North
 * - 90° = East
 * - 180° = South
 * - 270° = West
 * 
 * Clock position conventions:
 * - 12 o'clock = straight ahead (0° relative)
 * - 3 o'clock = right (90° relative)
 * - 6 o'clock = behind (180° relative)
 * - 9 o'clock = left (270° relative)
 */
export class DirectionTranslator {
  /**
   * Normalizes an angle to be within 0-360 degrees
   * @param angle - Angle in degrees
   * @returns Normalized angle (0-360)
   */
  private normalizeAngle(angle: number): number {
    let normalized = angle % 360;
    if (normalized < 0) {
      normalized += 360;
    }
    return normalized;
  }

  /**
   * Calculates the relative angle from user's heading to target heading
   * Returns the shortest angular difference (-180 to 180 degrees)
   * @param targetHeading - Absolute compass heading of the target (0-360°)
   * @param userHeading - User's current absolute compass heading (0-360°)
   * @returns Relative angle in degrees (-180 to 180, positive = clockwise)
   */
  private getRelativeAngle(targetHeading: number, userHeading: number): number {
    const target = this.normalizeAngle(targetHeading);
    const user = this.normalizeAngle(userHeading);
    
    let diff = target - user;
    
    // Normalize to -180 to 180 range
    if (diff > 180) {
      diff -= 360;
    } else if (diff < -180) {
      diff += 360;
    }
    
    return diff;
  }

  /**
   * Converts absolute compass direction to user-relative clock position (1-12)
   * 
   * @param targetHeading - Absolute compass heading of the target (0-360°)
   * @param userHeading - User's current absolute compass heading (0-360°)
   * @returns Clock position as integer (1-12)
   * 
   * @example
   * // Target is East (90°), user facing North (0°)
   * compassToClock(90, 0) // Returns 3 (3 o'clock, to their right)
   * 
   * @example
   * // Target is straight ahead
   * compassToClock(0, 0) // Returns 12 (12 o'clock, straight ahead)
   */
  compassToClock(targetHeading: number, userHeading: number): number {
    const relativeAngle = this.getRelativeAngle(targetHeading, userHeading);
    
    // Convert relative angle to positive 0-360 range
    const positiveAngle = relativeAngle < 0 ? relativeAngle + 360 : relativeAngle;
    
    // Map angle to clock position (30° per hour)
    // 0° = 12 o'clock, 30° = 1 o'clock, etc.
    let clock = Math.round(positiveAngle / 30);
    
    // Handle edge case: 360° should be 12, not 0
    if (clock === 0 || clock === 12) {
      return 12;
    }
    
    return clock;
  }

  /**
   * Converts clock position to natural speech description
   * 
   * @param clock - Clock position (1-12)
   * @returns Natural language description of the direction
   * 
   * @example
   * clockToSpeech(12) // "straight ahead"
   * clockToSpeech(3)  // "on your right"
   * clockToSpeech(9)  // "on your left"
   * clockToSpeech(6)  // "behind you"
   * clockToSpeech(2)  // "at 2 o'clock"
   */
  clockToSpeech(clock: number): string {
    // Normalize clock to 1-12 range
    const normalizedClock = ((clock - 1) % 12) + 1;
    
    switch (normalizedClock) {
      case 12:
        return 'straight ahead';
      case 3:
        return 'on your right';
      case 9:
        return 'on your left';
      case 6:
        return 'behind you';
      default:
        return `at ${normalizedClock} o'clock`;
    }
  }

  /**
   * Determines turn direction instruction between two headings
   * 
   * @param fromHeading - Current heading (0-360°)
   * @param toHeading - Target heading (0-360°)
   * @returns Natural language turn instruction
   * 
   * @example
   * getTurnDirection(0, 10)   // "continue straight" (small angle)
   * getTurnDirection(0, 45)   // "bear right" (medium angle)
   * getTurnDirection(0, 90)   // "turn right" (large angle)
   * getTurnDirection(0, 150)  // "turn sharp right" (very large angle)
   * getTurnDirection(0, 200)  // "turn around" (near 180°)
   */
  getTurnDirection(fromHeading: number, toHeading: number): string {
    const relativeAngle = this.getRelativeAngle(toHeading, fromHeading);
    const absAngle = Math.abs(relativeAngle);
    
    // Determine if left or right turn
    const isRight = relativeAngle > 0;
    const direction = isRight ? 'right' : 'left';
    
    // Handle near-straight (within 20°)
    if (absAngle <= 20) {
      return 'continue straight';
    }
    
    // Handle turn around (near 180°)
    if (absAngle >= 160 && absAngle <= 200) {
      return 'turn around';
    }
    
    // Handle very large turn (>120°)
    if (absAngle > 120) {
      return `turn sharp ${direction}`;
    }
    
    // Handle large turn (60-120°)
    if (absAngle >= 60) {
      return `turn ${direction}`;
    }
    
    // Handle medium turn (20-60°)
    return `bear ${direction}`;
  }

  /**
   * Generates a complete navigation instruction combining action, direction, distance, and optional landmark
   * 
   * @param action - Navigation action type: "walk", "turn", "exit_room", "enter_room"
   * @param targetHeading - Absolute compass heading of the target (0-360°)
   * @param userHeading - User's current absolute compass heading (0-360°)
   * @param distanceSteps - Distance in steps (optional for turn actions)
   * @param landmark - Optional landmark description to include
   * @returns Complete natural language navigation instruction
   * 
   * @example
   * generateInstruction("walk", 0, 0, 10)
   * // "Walk straight ahead, about 10 steps"
   * 
   * @example
   * generateInstruction("turn", 90, 0, 0)
   * // "Turn to your right"
   * 
   * @example
   * generateInstruction("exit_room", 90, 0, 2, "window")
   * // "Exit through door on your right, near the window"
   */
  generateInstruction(
    action: string,
    targetHeading: number,
    userHeading: number,
    distanceSteps: number = 0,
    landmark?: string,
    allLandmarks?: string[]
  ): string {
    const clock = this.compassToClock(targetHeading, userHeading);
    const direction = this.clockToSpeech(clock);
    
    // Pick the best landmark hint: explicit single landmark, or first from array
    const landmarkHint = landmark || (allLandmarks && allLandmarks.length > 0 ? allLandmarks[0] : undefined);
    
    let instruction = '';
    
    switch (action) {
      case 'walk':
        if (distanceSteps > 0) {
          instruction = `Walk ${direction}, about ${distanceSteps} step${distanceSteps !== 1 ? 's' : ''}`;
        } else {
          instruction = `Walk ${direction}`;
        }
        if (landmarkHint) {
          instruction += `. Look for ${landmarkHint}`;
        }
        break;
        
      case 'turn':
        // For turns, use the turn direction method for more natural language
        const turnDir = this.getTurnDirection(userHeading, targetHeading);
        instruction = turnDir.charAt(0).toUpperCase() + turnDir.slice(1);
        if (landmarkHint) {
          instruction += `, near ${landmarkHint}`;
        }
        break;
        
      case 'exit_room':
        instruction = `Exit through door ${direction}`;
        if (landmarkHint) {
          instruction += `, near the ${landmarkHint}`;
        }
        break;
        
      case 'enter_room':
        if (distanceSteps > 0) {
          instruction = `Walk ${direction}, about ${distanceSteps} step${distanceSteps !== 1 ? 's' : ''}`;
        } else {
          instruction = `Continue ${direction}`;
        }
        if (landmarkHint) {
          instruction += `. You should see ${landmarkHint} nearby`;
        }
        break;
        
      default:
        // Generic instruction for unknown actions
        instruction = `Go ${direction}`;
        if (distanceSteps > 0) {
          instruction += `, about ${distanceSteps} step${distanceSteps !== 1 ? 's' : ''}`;
        }
        if (landmarkHint) {
          instruction += `. Near ${landmarkHint}`;
        }
    }
    
    return instruction;
  }
}
