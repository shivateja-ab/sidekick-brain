import type { ConnectedClient } from './SessionManager';
import type { ClientMessage, WebSocketServices } from './types';
import { ServerMessage } from '../services/NavigationEngine';
import type { NavigationEngine } from '../services/NavigationEngine';
import type { SessionManager } from './SessionManager';
import type { TriggerEvaluator } from '../services/TriggerEvaluator';

/**
 * Send a message to a WebSocket client
 * 
 * @param socket - WebSocket connection
 * @param message - Server message to send
 */
function sendToClient(socket: any, message: ServerMessage): void {
  try {
    if (socket.readyState === 1) {
      // WebSocket.OPEN = 1
      socket.send(JSON.stringify(message));
    }
  } catch (error) {
    console.error('[WS] Error sending message:', error);
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
    code,
    message,
    speech: message,
    recoverable,
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
    const { flatMapId, destinationRoomId, currentRoomId, currentHeading } = payload;

    if (!flatMapId || !destinationRoomId) {
      return [
        createErrorMessage(
          'validation_error',
          'flatMapId and destinationRoomId are required',
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

    console.log(`[WS] Navigation started: sessionId=${session.id}, clientId=${client.id}`);

    return messages;
  } catch (error: any) {
    console.error('[WS] Start navigation error:', error);
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
    console.error('[WS] Sensor update error:', error);
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
    console.error('[WS] Visual response error:', error);
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

    // Decrease confidence slightly
    session.confidence = Math.max(0.3, session.confidence - 0.1);

    // Persist session
    // Note: NavigationEngine should have a method to update session, but for now we'll just return instruction

    return [
      {
        type: 'instruction',
        speech: 'Continuing navigation. If you need help, just ask.',
        priority: 'normal',
        currentSegmentIndex: session.currentSegmentIndex,
        stepsRemaining: 0,
        confidence: session.confidence,
      },
    ];
  } catch (error: any) {
    console.error('[WS] Visual skipped error:', error);
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
    const triggerEvaluator = (services as any).triggerEvaluator as TriggerEvaluator;

    // Map common phrases to actions
    if (lowerCommand.includes('where am i') || lowerCommand.includes('current position')) {
      // Request position check
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

      const trigger = triggerEvaluator.createUserRequestTrigger(session, command);
      session.pendingVisualRequest = true;

      return [
        {
          type: 'request_visual',
          trigger,
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

      const trigger = triggerEvaluator.createUserRequestTrigger(session, command);
      session.pendingVisualRequest = true;

      return [
        {
          type: 'request_visual',
          trigger,
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
        speech: "I didn't understand that. Try saying 'where am I', 'pause', 'cancel', or 'repeat'.",
        priority: 'normal',
        currentSegmentIndex: 0,
        stepsRemaining: 0,
        confidence: 1.0,
      },
    ];
  } catch (error: any) {
    console.error('[WS] Voice command error:', error);
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
    console.error('[WS] Pause error:', error);
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
    console.error('[WS] Resume error:', error);
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

    if (!client.sessionId) {
      return [
        createErrorMessage('no_active_session', 'No active navigation session', true),
      ];
    }

    const messages = await navigationEngine.cancelNavigation(client.sessionId);

    // Clear active session
    sessionManager.clearActiveSession(client.id);

    return messages;
  } catch (error: any) {
    console.error('[WS] Cancel error:', error);
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
          speech: 'No current instruction available.',
          priority: 'normal',
          currentSegmentIndex: session.currentSegmentIndex,
          stepsRemaining: 0,
          confidence: session.confidence,
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
        speech: instruction,
        priority: 'normal',
        currentSegmentIndex: session.currentSegmentIndex,
        stepsRemaining: Math.max(0, currentSegment.distanceSteps - session.stepsTakenInSegment),
        confidence: session.confidence,
      },
    ];
  } catch (error: any) {
    console.error('[WS] Repeat error:', error);
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
      type: 'position_update',
      confidence: 1.0,
      currentRoom: '',
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
  try {
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
    console.error('[WS] Message handler error:', error);
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
