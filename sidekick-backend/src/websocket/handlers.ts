import type { ConnectedClient } from './SessionManager.js';
import type { ClientMessage, WebSocketServices } from './types.js';
import { ServerMessage } from '../services/NavigationEngine.js';
import { logger } from '../utils/logger.js';
import type { NavigationEngine } from '../services/NavigationEngine.js';
import type { SessionManager } from './SessionManager.js';
import type { TriggerEvaluator } from '../services/TriggerEvaluator.js';

function sanitizeForWsLog(value: unknown): unknown {
  if (!value || typeof value !== 'object') return value;

  const obj: any = value;
  const type = obj.type;

  if (type === 'visual_response' && obj.payload && typeof obj.payload === 'object') {
    const p: any = { ...obj.payload };
    if (typeof p.currentImage === 'string') p.currentImage = `<base64:${p.currentImage.length}>`;
    if (typeof p.referenceImage === 'string') p.referenceImage = `<base64:${p.referenceImage.length}>`;
    return { ...obj, payload: p };
  }

  if (type === 'request_visual' && obj.payload && typeof obj.payload === 'object') {
    const p: any = { ...obj.payload };
    if (p.trigger && typeof p.trigger === 'object') {
      const trigger: any = { ...p.trigger };
      if (trigger.validation && typeof trigger.validation === 'object') {
        const validation: any = { ...trigger.validation };
        if (typeof validation.referenceImage === 'string') {
          validation.referenceImage = `<base64:${validation.referenceImage.length}>`;
        }
        trigger.validation = validation;
      }
      p.trigger = trigger;
    }
    return { ...obj, payload: p };
  }

  return value;
}

/**
 * Send a message to a WebSocket client
 * 
 * @param socket - WebSocket connection
 * @param message - Server message to send
 */
function sendToClient(socket: any, message: ServerMessage): void {
  try {
    if (socket.readyState === 1) {
      const messageStr = JSON.stringify(sanitizeForWsLog(message));
      logger.log(`[WS] SENDING: ${messageStr}`);
      socket.send(messageStr);
    }
  } catch (error: any) {
    logger.error('[WS] Error sending message:', error.message, error.stack);
  }
}

/**
 * Send multiple messages to a client
 * 
 * @param socket - WebSocket connection
 * @param messages - Array of server messages
 */
function sendMessages(socket: any, messages: ServerMessage[]): void {
  for (const message of messages) {
    sendToClient(socket, message);
  }
}

/**
 * Create error message
 */
function createErrorMessage(
  code: string,
  message: string,
  recoverable: boolean = true
): ServerMessage {
  return {
    type: 'error',
    payload: {
      code,
      message,
      speech: message,
      recoverable,
    },
    sessionId: '', // Root-level for compatibility
    timestamp: Date.now(),
  };
}

/**
 * Handle start navigation command
 */
export async function handleStartNavigation(
  client: ConnectedClient,
  payload: Extract<ClientMessage, { type: 'start_navigation' }>['payload'],
  services: WebSocketServices
): Promise<ServerMessage[]> {
  try {
    const { flatMapId, destinationRoomId, currentRoomId, currentHeading, destination, currentPosition } = payload;

    // Check if this is outdoor navigation (GPS-based)
    if (destination && currentPosition) {
      return handleOutdoorNavigation(client, { destination, currentPosition }, services);
    }

    // Indoor navigation (existing logic)
    if (!flatMapId || !destinationRoomId) {
      return [
        createErrorMessage(
          'validation_error',
          'flatMapId and destinationRoomId are required for indoor navigation, or destination and currentPosition for outdoor navigation',
          true
        ),
      ];
    }

    const navigationEngine = services.navigationEngine as NavigationEngine;
    const sessionManager = services.sessionManager as SessionManager;

    // Start navigation
    const { session, messages } = await navigationEngine.startNavigation(
      client.userId,
      flatMapId,
      destinationRoomId,
      currentRoomId,
      currentHeading
    );

    // Store active session
    sessionManager.setActiveSession(client.id, session.id);

    logger.log(`[WS] Navigation started: sessionId=${session.id}, clientId=${client.id}`);

    return messages;
  } catch (error: any) {
    logger.error('[WS] Start navigation error:', error.message, error.stack);
    return [
      createErrorMessage(
        'navigation_error',
        error.message || 'Failed to start navigation',
        true
      ),
    ];
  }
}

/**
 * Track outdoor navigation sessions (simple in-memory store)
 */
const outdoorNavigationSessions = new Map<string, {
  userId: string;
  destination: string;
  startTime: Date;
  currentPosition: { lat: number; lng: number } | null;
  heading: number | null;
}>();

/**
 * Handle outdoor navigation (GPS-based)
 */
async function handleOutdoorNavigation(
  client: ConnectedClient,
  payload: { destination: string; currentPosition: { lat: number; lng: number } },
  services: WebSocketServices
): Promise<ServerMessage[]> {
  const { destination, currentPosition } = payload;
  const sessionManager = services.sessionManager as SessionManager;

  logger.log(`[WS] Starting outdoor navigation for ${client.userId} to ${destination}`);

  // Create a session ID for outdoor navigation
  const sessionId = `outdoor_${Date.now()}_${client.id}`;
  sessionManager.setActiveSession(client.id, sessionId);

  // Store outdoor navigation session
  outdoorNavigationSessions.set(sessionId, {
    userId: client.userId,
    destination,
    startTime: new Date(),
    currentPosition,
    heading: null,
  });

  // TODO: Call routing API (Google Directions, OSRM, etc.) to get route
  // For now, send mock route data
  const mockRoute: ServerMessage = {
    type: 'route_update',
    sessionId: `outdoor_${Date.now()}_${client.id}`,
    timestamp: Date.now(),
    payload: {
      totalDistance: 1250, // meters
      estimatedTime: 900, // seconds (15 min)
      steps: [
        {
          instruction: 'Head north on Main Street',
          distance: 200,
          maneuver: 'straight',
          bearing: 0,
        },
        {
          instruction: 'Turn right onto Oak Avenue',
          distance: 350,
          maneuver: 'turn-right',
          bearing: 90,
        },
        {
          instruction: 'Continue straight for 400 meters',
          distance: 400,
          maneuver: 'straight',
          bearing: 90,
        },
        {
          instruction: 'Turn left onto Pine Road',
          distance: 200,
          maneuver: 'turn-left',
          bearing: 0,
        },
        {
          instruction: 'Your destination is on the right',
          distance: 100,
          maneuver: 'arrive',
          bearing: 0,
        },
      ],
    },
  };

  const firstInstruction: ServerMessage = {
    type: 'instruction',
    sessionId: mockRoute.sessionId,
    timestamp: Date.now(),
    payload: {
      text: mockRoute.payload.steps[0].instruction,
      speech: mockRoute.payload.steps[0].instruction,
      distance: mockRoute.payload.steps[0].distance,
      maneuver: mockRoute.payload.steps[0].maneuver,
      targetBearing: mockRoute.payload.steps[0].bearing,
      stepIndex: 0,
      totalSteps: mockRoute.payload.steps.length,
      priority: 'normal',
      currentSegmentIndex: 0,
      stepsRemaining: mockRoute.payload.totalDistance,
      totalStepsRemaining: mockRoute.payload.totalDistance,
      confidence: 1.0,
    },
  };

  logger.log(`[WS] Outdoor route generated: ${mockRoute.sessionId}`);
  return [mockRoute, firstInstruction];
}

/**
 * Handle sensor update
 */
export async function handleSensorUpdate(
  client: ConnectedClient,
  payload: Extract<ClientMessage, { type: 'sensor_update' }>['payload'],
  services: WebSocketServices
): Promise<ServerMessage[]> {
  try {
    const navigationEngine = services.navigationEngine as NavigationEngine;
    // const sessionManager = services.sessionManager as SessionManager;

    if (!client.sessionId) {
      return [
        createErrorMessage('no_active_session', 'No active navigation session', true),
      ];
    }

    // Process sensor update
    const messages = await navigationEngine.processSensorUpdate(client.sessionId, payload);

    return messages;
  } catch (error: any) {
    logger.error('[WS] Sensor update error:', error.message, error.stack);
    return [
      createErrorMessage('sensor_error', error.message || 'Failed to process sensor update', true),
    ];
  }
}

/**
 * Handle visual response
 */
export async function handleVisualResponse(
  client: ConnectedClient,
  payload: Extract<ClientMessage, { type: 'visual_response' }>['payload'],
  services: WebSocketServices
): Promise<ServerMessage[]> {
  try {
    const navigationEngine = services.navigationEngine as NavigationEngine;

    if (!client.sessionId) {
      return [
        createErrorMessage('no_active_session', 'No active navigation session', true),
      ];
    }

    // Process visual response
    const messages = await navigationEngine.processVisualResponse(client.sessionId, payload);

    return messages;
  } catch (error: any) {
    logger.error('[WS] Visual response error:', error.message, error.stack);
    return [
      createErrorMessage(
        'visual_error',
        error.message || 'Failed to process visual response',
        true
      ),
    ];
  }
}

/**
 * Handle visual skipped
 */
export async function handleVisualSkipped(
  client: ConnectedClient,
  _payload: Extract<ClientMessage, { type: 'visual_skipped' }>['payload'],
  services: WebSocketServices
): Promise<ServerMessage[]> {
  try {
    const navigationEngine = services.navigationEngine as NavigationEngine;

    if (!client.sessionId) {
      return [
        createErrorMessage('no_active_session', 'No active navigation session', true),
      ];
    }

    // Get session
    const session = navigationEngine.getSession(client.sessionId);
    if (!session) {
      return [
        createErrorMessage('session_not_found', 'Navigation session not found', false),
      ];
    }

    // Clear pending visual request
    session.pendingVisualRequest = false;

    // Resume navigation state so sensor updates continue to be processed
    if ((session as any).status === 'awaiting_visual' || (session as any).status === 'confirming_start') {
      (session as any).status = 'navigating';
    }

    // Decrease confidence slightly
    session.confidence = Math.max(0.3, session.confidence - 0.1);

    // Persist session
    // Note: NavigationEngine should have a method to update session, but for now we'll just return instruction

    return [
      {
        type: 'instruction',
        payload: {
          speech: 'Continuing navigation. If you need help, just ask.',
          priority: 'normal',
          currentSegmentIndex: session.currentSegmentIndex,
          stepsRemaining: 0,
          totalStepsRemaining: 0,
          confidence: session.confidence,
        },
      },
    ];
  } catch (error: any) {
    logger.error('[WS] Visual skipped error:', error.message, error.stack);
    return [
      createErrorMessage('visual_skipped_error', error.message || 'Failed to handle skipped visual', true),
    ];
  }
}

/**
 * Handle voice command
 */
export async function handleVoiceCommand(
  client: ConnectedClient,
  payload: Extract<ClientMessage, { type: 'voice_command' }>['payload'],
  services: WebSocketServices
): Promise<ServerMessage[]> {
  try {
    const { command } = payload;
    const lowerCommand = command.toLowerCase().trim();

    const navigationEngine = services.navigationEngine as NavigationEngine;
    // const sessionManager = services.sessionManager as SessionManager;
    const triggerEvaluator = (services as any).triggerEvaluator as TriggerEvaluator | undefined;

    // Map common phrases to actions
    if (
      lowerCommand.includes('where am i') ||
      lowerCommand.includes('current position') ||
      lowerCommand === 'where' ||
      lowerCommand.includes(' where ') ||
      lowerCommand.includes('location')
    ) {
      if (!client.sessionId) {
        return [createErrorMessage('no_active_session', 'No active navigation session', true)];
      }

      const session = navigationEngine.getSession(client.sessionId);
      if (!session) {
        return [createErrorMessage('session_not_found', 'Navigation session not found', true)];
      }

      const currentSegment = (session as any).path?.[(session as any).currentSegmentIndex];
      const expectedHeading = currentSegment?.compassHeading;

      session.pendingVisualRequest = true;

      return [
        {
          type: 'request_visual',
          payload: {
            trigger: {
              reason: 'user_requested',
              priority: 'normal',
              message: 'Checking your position',
              capture: {
                mode: 'auto',
                delaySeconds: 1,
                guidanceAudio: 'Hold phone forward at chest level',
                expectedHeading: typeof expectedHeading === 'number' ? expectedHeading : undefined,
              },
              validation: {
                query: 'validate_position',
                expectedRoom: currentSegment?.toRoomId || (session as any).currentRoomId,
                expectedLandmarks: currentSegment?.expectedLandmarks || [],
                referenceImageId: null,
              },
            },
          },
        },
      ];
    }

    if (lowerCommand.includes("what's around") || lowerCommand.includes('describe')) {
      // Request scene description
      if (!client.sessionId) {
        return [
          createErrorMessage('no_active_session', 'No active navigation session', true),
        ];
      }

      const session = navigationEngine.getSession(client.sessionId);
      if (!session) {
        return [
          createErrorMessage('session_not_found', 'Navigation session not found', false),
        ];
      }

      if (!triggerEvaluator) {
        return [
          createErrorMessage(
            'service_unavailable',
            'Voice commands are temporarily unavailable on the server.',
            true
          ),
        ];
      }

      const trigger = triggerEvaluator.createUserRequestTrigger(session, command);
      session.pendingVisualRequest = true;

      return [
        {
          type: 'request_visual',
          payload: {
            trigger,
          },
        },
      ];
    }

    if (lowerCommand.includes('stop') || lowerCommand.includes('cancel')) {
      return handleCancel(client, {}, services);
    }

    if (lowerCommand.includes('pause')) {
      return handlePause(client, {}, services);
    }

    if (lowerCommand.includes('continue') || lowerCommand.includes('resume')) {
      return handleResume(client, {}, services);
    }

    if (lowerCommand.includes('repeat')) {
      return handleRepeat(client, {}, services);
    }

    // Unknown command
    return [
      {
        type: 'instruction',
        payload: {
          speech: "I didn't understand that. Try saying 'where am I', 'pause', 'cancel', or 'repeat'.",
          priority: 'normal',
          currentSegmentIndex: 0,
          stepsRemaining: 0,
          totalStepsRemaining: 0,
          confidence: 1.0,
        },
      },
    ];
  } catch (error: any) {
    logger.error('[WS] Voice command error:', error.message, error.stack);
    return [
      createErrorMessage('voice_command_error', error.message || 'Failed to process voice command', true),
    ];
  }
}

/**
 * Handle pause navigation
 */
export async function handlePause(
  client: ConnectedClient,
  _payload: Record<string, never>,
  services: WebSocketServices
): Promise<ServerMessage[]> {
  try {
    const navigationEngine = services.navigationEngine as NavigationEngine;

    if (!client.sessionId) {
      return [
        createErrorMessage('no_active_session', 'No active navigation session', true),
      ];
    }

    const messages = await navigationEngine.pauseNavigation(client.sessionId);
    return messages;
  } catch (error: any) {
    logger.error('[WS] Pause error:', error.message, error.stack);
    return [
      createErrorMessage('pause_error', error.message || 'Failed to pause navigation', true),
    ];
  }
}

/**
 * Handle resume navigation
 */
export async function handleResume(
  client: ConnectedClient,
  _payload: Record<string, never>,
  services: WebSocketServices
): Promise<ServerMessage[]> {
  try {
    const navigationEngine = services.navigationEngine as NavigationEngine;

    if (!client.sessionId) {
      return [
        createErrorMessage('no_active_session', 'No active navigation session', true),
      ];
    }

    const messages = await navigationEngine.resumeNavigation(client.sessionId);
    return messages;
  } catch (error: any) {
    logger.error('[WS] Resume error:', error.message, error.stack);
    return [
      createErrorMessage('resume_error', error.message || 'Failed to resume navigation', true),
    ];
  }
}

/**
 * Handle cancel navigation
 */
export async function handleCancel(
  client: ConnectedClient,
  _payload: Record<string, never>,
  services: WebSocketServices
): Promise<ServerMessage[]> {
  try {
    const navigationEngine = services.navigationEngine as NavigationEngine;
    const sessionManager = services.sessionManager as SessionManager;

    if (client.sessionId && client.sessionId.startsWith('outdoor_')) {
      // Outdoor navigation - clear session and send confirmation
      outdoorNavigationSessions.delete(client.sessionId);
      sessionManager.clearActiveSession(client.id);

      logger.log(`[WS] Outdoor navigation cancelled for ${client.userId}`);

      return [
        {
          type: 'navigation_cancelled',
          payload: {
            speech: 'Navigation cancelled',
          },
        },
      ];
    }

    // Indoor navigation session
    if (client.sessionId) {
      const messages = await navigationEngine.cancelNavigation(client.sessionId);
      sessionManager.clearActiveSession(client.id);
      return messages;
    }

    return [
      createErrorMessage('no_active_session', 'No active navigation session', true),
    ];
  } catch (error: any) {
    logger.error('[WS] Cancel error:', error.message, error.stack);
    return [
      createErrorMessage('cancel_error', error.message || 'Failed to cancel navigation', true),
    ];
  }
}

/**
 * Handle repeat last instruction
 */
export async function handleRepeat(
  client: ConnectedClient,
  _payload: Record<string, never>,
  services: WebSocketServices
): Promise<ServerMessage[]> {
  try {
    const navigationEngine = services.navigationEngine as NavigationEngine;

    if (!client.sessionId) {
      return [
        createErrorMessage('no_active_session', 'No active navigation session', true),
      ];
    }

    const session = navigationEngine.getSession(client.sessionId);
    if (!session) {
      return [
        createErrorMessage('session_not_found', 'Navigation session not found', false),
      ];
    }

    // Get current segment
    const currentSegment = session.path[session.currentSegmentIndex];
    if (!currentSegment) {
      return [
        {
          type: 'instruction',
          payload: {
            speech: 'No current instruction available.',
            priority: 'normal',
            currentSegmentIndex: session.currentSegmentIndex,
            stepsRemaining: 0,
            totalStepsRemaining: 0,
            confidence: session.confidence,
          },
        },
      ];
    }

    // Generate instruction
    const directionTranslator = (services as any).directionTranslator;
    const instruction = directionTranslator.generateInstruction(
      currentSegment.action,
      currentSegment.compassHeading,
      session.currentCompassHeading,
      currentSegment.distanceSteps - session.stepsTakenInSegment,
      currentSegment.expectedLandmarks[0]
    );

    return [
      {
        type: 'instruction',
        payload: {
          speech: instruction,
          priority: 'normal',
          currentSegmentIndex: session.currentSegmentIndex,
          targetHeading: currentSegment.compassHeading,
          stepsRemaining: Math.max(0, currentSegment.distanceSteps - session.stepsTakenInSegment),
          totalStepsRemaining: 0,
          confidence: session.confidence,
        },
      },
    ];
  } catch (error: any) {
    logger.error('[WS] Repeat error:', error.message, error.stack);
    return [
      createErrorMessage('repeat_error', error.message || 'Failed to repeat instruction', true),
    ];
  }
}

/**
 * Handle ping message
 */
export async function handlePing(
  client: ConnectedClient,
  _payload: Record<string, never>,
  services: WebSocketServices
): Promise<ServerMessage[]> {
  const sessionManager = services.sessionManager as SessionManager;
  sessionManager.updatePing(client.id);

  return [
    {
      type: 'pong',
      payload: {
        timestamp: Date.now(),
      },
    },
  ];
}

/**
 * Main message router
 * 
 * Routes incoming client messages to appropriate handlers
 */
export async function handleMessage(
  client: ConnectedClient,
  message: ClientMessage,
  services: WebSocketServices
): Promise<ServerMessage[]> {
  logger.log(`[WS] RECEIVED: ${JSON.stringify(sanitizeForWsLog(message))}`);
  try {
    const sessionManager = services.sessionManager as SessionManager;
    const latestClient = sessionManager.getClientById(client.id);
    if (latestClient && latestClient.sessionId !== client.sessionId) {
      client.sessionId = latestClient.sessionId;
    }

    // Fallback: allow client to send root-level sessionId
    const messageSessionId = (message as any)?.sessionId;
    if (!client.sessionId && typeof messageSessionId === 'string' && messageSessionId.length > 0) {
      client.sessionId = messageSessionId;
      sessionManager.setActiveSession(client.id, messageSessionId);
    }

    switch (message.type) {
      case 'start_navigation':
        return handleStartNavigation(client, message.payload, services);

      case 'sensor_update':
        return handleSensorUpdate(client, message.payload, services);

      case 'visual_response':
        return handleVisualResponse(client, message.payload, services);

      case 'visual_skipped':
        return handleVisualSkipped(client, message.payload, services);

      case 'voice_command':
        return handleVoiceCommand(client, message.payload, services);

      case 'pause_navigation':
        return handlePause(client, message.payload || {}, services);

      case 'resume_navigation':
        return handleResume(client, message.payload || {}, services);

      case 'cancel_navigation':
        return handleCancel(client, message.payload || {}, services);

      case 'request_repeat':
        return handleRepeat(client, message.payload || {}, services);

      case 'ping':
        return handlePing(client, message.payload || {}, services);

      case 'position_report':
        return handlePositionReport(client, message.payload, services);

      case 'heading_report':
        return handleHeadingReport(client, message.payload, services);

      default:
        return [
          createErrorMessage(
            'unknown_message_type',
            `Unknown message type: ${(message as any).type}`,
            true
          ),
        ];
    }
  } catch (error: any) {
    logger.error('[WS] Message router error:', error.message, error.stack);
    return [
      createErrorMessage(
        'handler_error',
        error.message || 'Failed to process message',
        true
      ),
    ];
  }
}

/**
 * Send messages to client (exported version)
 */
export function sendMessageToClient(socket: any, message: ServerMessage): void {
  sendToClient(socket, message);
}

/**
 * Send multiple messages to client (exported version)
 */
export function sendMessagesToClient(socket: any, messages: ServerMessage[]): void {
  sendMessages(socket, messages);
}

/**
 * Handle position report (outdoor navigation)
 */
export async function handlePositionReport(
  client: ConnectedClient,
  payload: Extract<ClientMessage, { type: 'position_report' }>['payload'],
  _services: WebSocketServices
): Promise<ServerMessage[]> {
  try {
    const { position, accuracy } = payload;

    logger.log(`[WS] Position report from ${client.id}: lat=${position.lat}, lng=${position.lng}, accuracy=${accuracy}m`);

    // Update outdoor navigation session if exists
    if (client.sessionId && client.sessionId.startsWith('outdoor_')) {
      const session = outdoorNavigationSessions.get(client.sessionId);
      if (session) {
        session.currentPosition = position;
      }
    }

    // TODO: Calculate distance to next maneuver
    // TODO: Check if user has deviated from route
    // TODO: Send updated instruction if approaching turn

    // For now, just acknowledge the position
    return [
      {
        type: 'position_ack',
        payload: {
          timestamp: Date.now(),
        },
      },
    ];
  } catch (error: any) {
    logger.error('[WS] Position report error:', error.message, error.stack);
    return [
      createErrorMessage('position_error', error.message || 'Failed to process position report', true),
    ];
  }
}

/**
 * Handle heading report (outdoor navigation)
 */
export async function handleHeadingReport(
  client: ConnectedClient,
  payload: Extract<ClientMessage, { type: 'heading_report' }>['payload'],
  _services: WebSocketServices
): Promise<ServerMessage[]> {
  try {
    const { heading } = payload;

    // Update outdoor navigation session if exists
    if (client.sessionId && client.sessionId.startsWith('outdoor_')) {
      const session = outdoorNavigationSessions.get(client.sessionId);
      if (session) {
        session.heading = heading;
      }
    }

    // The mobile app uses heading + targetBearing to show direction arrow
    // No response needed for heading updates, just log it
    logger.log(`[WS] Heading report from ${client.id}: ${heading}°`);

    // Return empty array - no response needed
    return [];
  } catch (error: any) {
    logger.error('[WS] Heading report error:', error.message, error.stack);
    // Don't send error for heading reports - they're fire-and-forget
    return [];
  }
}
