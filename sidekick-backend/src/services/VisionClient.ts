/**
 * Vision Context for API requests
 */
import { logger } from '../utils/logger.js';
export interface VisionContext {
  query: 'validate_position' | 'identify_room' | 'check_obstacles';
  expectedRoom?: string;
  expectedLandmarks?: string[];
  currentInstruction?: string;
  stepsIntoSegment?: number;
}

/**
 * Vision API Request payload
 */
export interface VisionRequest {
  currentImage: string; // Base64 encoded JPEG
  referenceImage?: string; // Base64 encoded JPEG (for comparison)
  context: VisionContext;
}

/**
 * Vision API Response payload
 * 
 * Fields vary based on query type:
 * - validate_position: isOnTrack, confidence, detectedRoom, landmarksVisible, etc.
 * - identify_room: roomType, keyFeatures, doors
 * - check_obstacles: detected, obstacles
 */
export interface VisionResponse {
  success: boolean;

  // Position validation fields
  isOnTrack?: boolean;
  confidence?: number; // 0.0 to 1.0
  detectedRoom?: string;
  landmarksVisible?: string[];
  correctionNeeded?: boolean;
  suggestedHeading?: number;

  // Room identification fields
  roomType?: string;
  keyFeatures?: string[];
  doors?: Array<{
    position: string;
    type: string;
    status: string;
  }>;

  // Obstacle detection fields
  detected?: boolean;
  obstacles?: Array<{
    type: string;
    position: string;
    distance: string;
    urgent: boolean;
  }>;

  // Always present
  speech: string;
  error?: string;
}

/**
 * VisionClient Service
 * 
 * Wraps HTTP calls to the Vercel Edge Vision API endpoint.
 * Handles request formatting, error handling, and response parsing.
 * 
 * The Vision API uses Gemini to compare/analyze images for navigation validation.
 * 
 * @example
 * const client = new VisionClient();
 * const result = await client.validatePosition(
 *   currentImageBase64,
 *   referenceImageBase64,
 *   { expectedRoom: 'bedroom-1', expectedLandmarks: ['bed', 'window'] }
 * );
 * if (result.success && result.isOnTrack) {
 *   console.log('User is on track!');
 * }
 */
export class VisionClient {
  private readonly apiUrl: string;

  /**
   * Creates a new VisionClient instance
   * 
   * @param apiUrl - Optional API URL. Defaults to process.env.VISION_API_URL
   * @throws Error if no URL provided and VISION_API_URL env var is not set
   * 
   * @example
   * // Using environment variable
   * const client = new VisionClient();
   * 
   * @example
   * // Using explicit URL
   * const client = new VisionClient('https://custom-api.example.com/vision');
   */
  constructor(apiUrl?: string) {
    const url = apiUrl || process.env.VISION_API_URL;
    if (!url) {
      throw new Error(
        'Vision API URL not provided. Set VISION_API_URL environment variable or pass apiUrl parameter.'
      );
    }
    this.apiUrl = url;
  }

  /**
   * Validates user's current position by comparing with reference image
   * 
   * Convenience method that sets query to 'validate_position' and calls the API.
   * 
   * @param currentImage - Base64 encoded JPEG of current view
   * @param referenceImage - Base64 encoded JPEG of reference/expected view
   * @param context - Context information (expectedRoom, expectedLandmarks, etc.)
   * @returns VisionResponse with validation results
   * 
   * @example
   * const result = await client.validatePosition(
   *   currentImageBase64,
   *   referenceImageBase64,
   *   {
   *     expectedRoom: 'bedroom-1',
   *     expectedLandmarks: ['bed', 'window'],
   *     currentInstruction: 'Walk straight ahead',
   *     stepsIntoSegment: 5
   *   }
   * );
   * 
   * if (result.success && result.isOnTrack) {
   *   console.log(`Confidence: ${result.confidence}`);
   *   console.log(`Detected room: ${result.detectedRoom}`);
   * }
   */
  async validatePosition(
    currentImage: string,
    referenceImage: string,
    context: Omit<VisionContext, 'query'>
  ): Promise<VisionResponse> {
    return this.sendRequest({
      currentImage,
      referenceImage,
      context: {
        ...context,
        query: 'validate_position',
      },
    });
  }

  /**
   * Identifies the room from a single image
   * 
   * Convenience method that sets query to 'identify_room' and calls the API.
   * No reference image needed - open-ended room identification.
   * 
   * @param image - Base64 encoded JPEG of current view
   * @returns VisionResponse with room identification results
   * 
   * @example
   * const result = await client.identifyRoom(imageBase64);
   * if (result.success) {
   *   console.log(`Room type: ${result.roomType}`);
   *   console.log(`Key features: ${result.keyFeatures?.join(', ')}`);
   *   console.log(`Doors: ${result.doors?.length || 0}`);
   * }
   */
  async identifyRoom(image: string): Promise<VisionResponse> {
    return this.sendRequest({
      currentImage: image,
      context: {
        query: 'identify_room',
      },
    });
  }

  /**
   * Checks for obstacles in the current view
   * 
   * Convenience method that sets query to 'check_obstacles' and calls the API.
   * 
   * @param image - Base64 encoded JPEG of current view
   * @returns VisionResponse with obstacle detection results
   * 
   * @example
   * const result = await client.checkObstacles(imageBase64);
   * if (result.success && result.detected) {
   *   const urgentObstacles = result.obstacles?.filter(o => o.urgent);
   *   console.log(`Found ${urgentObstacles?.length || 0} urgent obstacles`);
   * }
   */
  async checkObstacles(image: string): Promise<VisionResponse> {
    return this.sendRequest({
      currentImage: image,
      context: {
        query: 'check_obstacles',
      },
    });
  }

  /**
   * Sends HTTP POST request to Vision API
   * 
   * Handles request formatting, timeout, error handling, and response parsing.
   * Never throws - always returns a VisionResponse (even on error).
   * 
   * @param request - VisionRequest payload
   * @returns VisionResponse (success or error response)
   * 
   * @private
   */
  private async sendRequest(request: VisionRequest): Promise<VisionResponse> {
    const queryType = request.context.query;
    logger.log(`[VisionClient] Sending request: ${queryType}`);

    try {
      // Create AbortController for timeout
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 30000); // 30 second timeout

      try {
        // Make HTTP POST request
        const response = await fetch(this.apiUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(request),
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        // Handle HTTP errors
        if (!response.ok) {
          return this.handleHttpError(response, queryType);
        }

        // Parse JSON response
        const data: VisionResponse = await response.json();

        // Log response
        if (data.success) {
          logger.log(
            `[VisionClient] Response: success, confidence=${data.confidence || 'N/A'}, query=${queryType}`
          );
        } else {
          logger.log(
            `[VisionClient] Response: failure, error=${data.error || 'unknown'}, query=${queryType}`
          );
        }

        return data;
      } catch (fetchError) {
        clearTimeout(timeoutId);

        // Check if it's an abort (timeout)
        if (fetchError instanceof Error && fetchError.name === 'AbortError') {
          return this.handleError(
            new Error('Request timeout after 30 seconds'),
            `Timeout during ${queryType} request`
          );
        }

        // Re-throw to be caught by outer catch
        throw fetchError;
      }
    } catch (error) {
      return this.handleError(error, `Error during ${queryType} request`);
    }
  }

  /**
   * Handles HTTP error responses
   * 
   * @param response - Fetch Response object with non-2xx status
   * @param queryType - Query type for logging
   * @returns VisionResponse with error information
   * 
   * @private
   */
  private async handleHttpError(
    response: Response,
    queryType: string
  ): Promise<VisionResponse> {
    let errorMessage = 'Unknown HTTP error';
    let speech = "Something went wrong. Let's try again.";

    // Handle specific status codes
    if (response.status === 429) {
      errorMessage = 'Rate limit exceeded';
      speech = 'Too many requests. Please wait a moment.';
    } else if (response.status >= 500) {
      errorMessage = `Server error: ${response.status}`;
      speech = "Vision service error. Let's try again.";
    } else {
      errorMessage = `HTTP ${response.status}: ${response.statusText}`;
    }

    // Try to parse error response body
    try {
      const errorBody = await response.json();
      if (errorBody.error) {
        errorMessage = errorBody.error;
      }
      if (errorBody.speech) {
        speech = errorBody.speech;
      }
    } catch {
      // Ignore JSON parse errors, use defaults
    }

    logger.error(
      `[VisionClient] HTTP error: ${errorMessage}, status=${response.status}, query=${queryType}`
    );

    return {
      success: false,
      speech,
      error: errorMessage,
    };
  }

  /**
   * Converts any error into a safe VisionResponse
   * 
   * Handles network errors, JSON parse errors, and unknown errors.
   * Always returns a valid VisionResponse (never throws).
   * 
   * @param error - Any error object
   * @param context - Context string for logging
   * @returns VisionResponse with error information
   * 
   * @private
   */
  private handleError(error: unknown, context: string): VisionResponse {
    let errorMessage = 'Unknown error';
    let speech = "Something went wrong. Let's try again.";

    if (error instanceof Error) {
      errorMessage = error.message;

      // Handle specific error types
      if (error.message.includes('timeout') || error.message.includes('aborted')) {
        speech = "Taking too long to check. Let's try again.";
      } else if (error.message.includes('JSON') || error.message.includes('parse')) {
        speech = "Received invalid response. Let's try again.";
      } else if (error.message.includes('fetch') || error.message.includes('network')) {
        speech = "Network error. Let's try again.";
      }
    } else if (typeof error === 'string') {
      errorMessage = error;
    } else {
      errorMessage = String(error);
    }

    logger.error(`[VisionClient] Error: ${context}`, error instanceof Error ? { message: error.message, stack: error.stack } : error);

    return {
      success: false,
      speech,
      error: errorMessage,
    };
  }
}
