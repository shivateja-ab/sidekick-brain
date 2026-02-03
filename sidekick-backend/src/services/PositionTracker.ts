/**
 * PositionTracker Service
 * 
 * Estimates user's position using dead reckoning based on step count and compass heading.
 * Manages confidence decay - the longer since last visual confirmation, the less confident
 * we are about position accuracy.
 * 
 * Coordinate system:
 * - Origin (0,0) is the starting point
 * - X axis: positive = East, negative = West
 * - Y axis: positive = North, negative = South
 * - Compass heading 0° = North = +Y direction
 * - Compass heading 90° = East = +X direction
 */
export class PositionTracker {
  // Default step length in centimeters
  private readonly DEFAULT_STEP_LENGTH_CM = 70;

  // Confidence decay per step (lose 1% confidence per step)
  private readonly CONFIDENCE_DECAY_PER_STEP = 0.01;

  // Confidence decay per second (lose 0.5% per second)
  private readonly CONFIDENCE_DECAY_PER_SECOND = 0.005;

  // Minimum confidence threshold (never go below 30%)
  private readonly MIN_CONFIDENCE = 0.3;

  // Maximum confidence after visual confirmation (caps at 95%)
  private readonly MAX_CONFIDENCE = 0.95;

  /**
   * Updates position based on steps taken in a given compass direction (dead reckoning)
   * 
   * @param currentPosition - Current position {x, y} in step units
   * @param steps - Number of steps taken
   * @param compassHeading - Compass heading in degrees (0° = North, 90° = East)
   * @returns New position {x, y} after movement
   * 
   * @example
   * // At origin, walk 10 steps heading North (0°)
   * updatePosition({x: 0, y: 0}, 10, 0)
   * // Returns: {x: 0, y: 10}
   * 
   * @example
   * // At origin, walk 10 steps heading East (90°)
   * updatePosition({x: 0, y: 0}, 10, 90)
   * // Returns: {x: 10, y: 0}
   * 
   * @example
   * // Walk 5 steps at 45° (Northeast)
   * updatePosition({x: 0, y: 0}, 5, 45)
   * // Returns: {x: ~3.54, y: ~3.54}
   */
  updatePosition(
    currentPosition: { x: number; y: number },
    steps: number,
    compassHeading: number
  ): { x: number; y: number } {
    // Convert compass heading to radians
    // Formula: radians = (90 - compassHeading) * (π / 180)
    // This converts from compass (0°=North) to standard math coordinates (0°=East)
    const radians = ((90 - compassHeading) * Math.PI) / 180;

    // Calculate displacement in step units
    const dx = steps * Math.cos(radians);
    const dy = steps * Math.sin(radians);

    // Return new position
    return {
      x: currentPosition.x + dx,
      y: currentPosition.y + dy,
    };
  }

  /**
   * Calculates decayed confidence based on time and distance since last visual confirmation
   * 
   * @param lastConfidence - Previous confidence value (0-1)
   * @param stepsSinceConfirm - Number of steps taken since last visual confirmation
   * @param secondsSinceConfirm - Number of seconds elapsed since last visual confirmation
   * @returns New confidence value (bounded by MIN_CONFIDENCE)
   * 
   * @example
   * // High confidence, small movement
   * calculateConfidence(1.0, 5, 2)
   * // Returns: 1.0 - 0.05 - 0.01 = 0.94
   * 
   * @example
   * // Moderate confidence, significant movement
   * calculateConfidence(1.0, 20, 10)
   * // Returns: 1.0 - 0.2 - 0.05 = 0.75
   * 
   * @example
   * // Low confidence, won't go below minimum
   * calculateConfidence(0.4, 15, 5)
   * // Returns: Math.max(0.3, 0.4 - 0.15 - 0.025) = Math.max(0.3, 0.225) = 0.3
   */
  calculateConfidence(
    lastConfidence: number,
    stepsSinceConfirm: number,
    secondsSinceConfirm: number
  ): number {
    // Calculate decay from steps
    const stepDecay = stepsSinceConfirm * this.CONFIDENCE_DECAY_PER_STEP;

    // Calculate decay from time
    const timeDecay = secondsSinceConfirm * this.CONFIDENCE_DECAY_PER_SECOND;

    // Apply decay
    const newConfidence = lastConfidence - stepDecay - timeDecay;

    // Ensure confidence doesn't drop below minimum threshold
    return Math.max(this.MIN_CONFIDENCE, newConfidence);
  }

  /**
   * Resets confidence after successful visual confirmation from Gemini
   * 
   * @param geminiConfidence - Confidence value from Gemini API (0-1)
   * @returns Adjusted confidence value (bounded by MAX_CONFIDENCE)
   * 
   * Formula: adjusted = geminiConfidence * 0.9 + 0.1
   * This slightly weights Gemini's confidence lower and adds a base boost
   * 
   * @example
   * // High Gemini confidence
   * resetConfidence(0.95)
   * // Returns: Math.min(0.95, 0.95 * 0.9 + 0.1) = Math.min(0.95, 0.955) = 0.95
   * 
   * @example
   * // Moderate Gemini confidence
   * resetConfidence(0.85)
   * // Returns: Math.min(0.95, 0.85 * 0.9 + 0.1) = Math.min(0.95, 0.865) = 0.865
   * 
   * @example
   * // Low Gemini confidence
   * resetConfidence(0.6)
   * // Returns: Math.min(0.95, 0.6 * 0.9 + 0.1) = Math.min(0.95, 0.64) = 0.64
   */
  resetConfidence(geminiConfidence: number): number {
    // Weight Gemini's confidence slightly lower and add base boost
    // This accounts for potential overconfidence in vision API
    const adjustedConfidence = geminiConfidence * 0.9 + 0.1;

    // Cap at maximum confidence threshold
    return Math.min(this.MAX_CONFIDENCE, adjustedConfidence);
  }

  /**
   * Estimates Euclidean distance between two positions in step units
   * 
   * @param posA - First position {x, y}
   * @param posB - Second position {x, y}
   * @returns Distance in step units
   * 
   * @example
   * // Distance from origin to (3, 4)
   * estimateDistanceBetween({x: 0, y: 0}, {x: 3, y: 4})
   * // Returns: Math.sqrt(9 + 16) = 5
   * 
   * @example
   * // Distance between two points
   * estimateDistanceBetween({x: 1, y: 2}, {x: 4, y: 6})
   * // Returns: Math.sqrt(9 + 16) = 5
   */
  estimateDistanceBetween(
    posA: { x: number; y: number },
    posB: { x: number; y: number }
  ): number {
    const dx = posB.x - posA.x;
    const dy = posB.y - posA.y;
    return Math.sqrt(dx * dx + dy * dy);
  }

  /**
   * Estimates compass heading to travel from one position to another
   * 
   * @param from - Starting position {x, y}
   * @param to - Target position {x, y}
   * @returns Compass heading in degrees (0-360, where 0° = North)
   * 
   * @example
   * // Heading from origin to (0, 10) - straight North
   * estimateHeadingBetween({x: 0, y: 0}, {x: 0, y: 10})
   * // Returns: 0 (North)
   * 
   * @example
   * // Heading from origin to (10, 0) - straight East
   * estimateHeadingBetween({x: 0, y: 0}, {x: 10, y: 0})
   * // Returns: 90 (East)
   * 
   * @example
   * // Heading from origin to (10, 10) - Northeast
   * estimateHeadingBetween({x: 0, y: 0}, {x: 10, y: 10})
   * // Returns: 45 (Northeast)
   * 
   * @example
   * // Heading from origin to (0, -10) - straight South
   * estimateHeadingBetween({x: 0, y: 0}, {x: 0, y: -10})
   * // Returns: 180 (South)
   */
  estimateHeadingBetween(
    from: { x: number; y: number },
    to: { x: number; y: number }
  ): number {
    const dx = to.x - from.x;
    const dy = to.y - from.y;

    // Use atan2 to get angle in radians
    // atan2(dy, dx) gives angle from positive X axis (East)
    const radians = Math.atan2(dy, dx);

    // Convert to degrees
    let degrees = (radians * 180) / Math.PI;

    // Convert from math coordinates (0° = East) to compass (0° = North)
    // Compass = 90 - math_angle, then normalize to 0-360
    degrees = 90 - degrees;

    // Normalize to 0-360 range
    if (degrees < 0) {
      degrees += 360;
    } else if (degrees >= 360) {
      degrees -= 360;
    }

    return degrees;
  }

  /**
   * Gets the default step length in centimeters
   * 
   * @returns Step length in cm
   */
  getDefaultStepLength(): number {
    return this.DEFAULT_STEP_LENGTH_CM;
  }

  /**
   * Gets the minimum confidence threshold
   * 
   * @returns Minimum confidence value
   */
  getMinConfidence(): number {
    return this.MIN_CONFIDENCE;
  }

  /**
   * Gets the maximum confidence threshold
   * 
   * @returns Maximum confidence value
   */
  getMaxConfidence(): number {
    return this.MAX_CONFIDENCE;
  }
}
