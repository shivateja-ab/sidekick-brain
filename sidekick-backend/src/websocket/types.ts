import type { SensorUpdatePayload, VisualResponsePayload } from '../services/NavigationEngine.js';
// import type { ConnectedClient } from './SessionManager';

/**
 * Client message types sent from mobile app
 */
export type ClientMessage =
  | {
    type: 'start_navigation';
    payload: {
      // Indoor navigation
      flatMapId?: string;
      destinationRoomId?: string;
      currentRoomId?: string;
      currentHeading?: number;
      // Outdoor navigation
      destination?: string;
      currentPosition?: { lat: number; lng: number };
    };
  }
  | {
    type: 'sensor_update';
    payload: SensorUpdatePayload;
  }
  | {
    type: 'visual_response';
    payload: VisualResponsePayload;
  }
  | {
    type: 'visual_skipped';
    payload?: {
      reason?: string;
    };
  }
  | {
    type: 'voice_command';
    payload: {
      command: string;
    };
  }
  | {
    type: 'pause_navigation';
    payload?: Record<string, never>;
  }
  | {
    type: 'resume_navigation';
    payload?: Record<string, never>;
  }
  | {
    type: 'cancel_navigation';
    payload?: Record<string, never>;
  }
  | {
    type: 'request_repeat';
    payload?: Record<string, never>;
  }
  | {
    type: 'ping';
    payload?: Record<string, never>;
  }
  | {
    type: 'position_report';
    payload: {
      position: { lat: number; lng: number };
      accuracy: number;
      timestamp: number;
    };
  }
  | {
    type: 'heading_report';
    payload: {
      heading: number; // 0-360 degrees
      timestamp: number;
    };
  };

/**
 * Services container for WebSocket handlers
 */
export interface WebSocketServices {
  navigationEngine: any; // NavigationEngine
  sessionManager: any; // SessionManager
  fastify: any; // FastifyInstance

}
