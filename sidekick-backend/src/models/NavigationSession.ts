export type SessionStatus =
  | 'initializing'
  | 'confirming_start'
  | 'navigating'
  | 'awaiting_visual'
  | 'recalculating'
  | 'paused'
  | 'completed'
  | 'cancelled'
  | 'failed';

export type SegmentAction =
  | 'walk'
  | 'turn'
  | 'exit_room'
  | 'enter_room'
  | 'climb_stairs'
  | 'descend_stairs';

export interface PathSegment {
  index: number;
  action: SegmentAction;
  fromRoomId: string;
  toRoomId: string;
  compassHeading: number;      // Absolute direction to travel
  distanceSteps: number;
  instruction: string;         // Generated at runtime with clock positions
  expectedLandmarks: string[];
  checkpoints: Checkpoint[];
}

export interface Checkpoint {
  id: string;
  atStep: number;
  type: 'info' | 'warning' | 'confirm';
  message: string;
  requiresVisualConfirm: boolean;
}

export interface NavigationSessionRuntime {
  id: string;
  userId: string;
  flatMapId: string;
  status: SessionStatus;
  destinationRoomId: string;
  path: PathSegment[];
  currentSegmentIndex: number;
  currentRoomId: string;
  estimatedPosition: { x: number; y: number };
  currentCompassHeading: number;
  confidence: number;
  stepsTakenInSegment: number;
  totalStepsInSegment: number;
  absStepsSinceLastConfirm: number;
  triggeredCheckpoints: string[];
  triggeredProximityAlerts: string[];
  lastVisualConfirmAt: Date | null;
  lastConfirmedRoomId: string | null;
  pendingVisualRequest: boolean;
  startedAt: Date;
  lastUpdateAt: Date;
  // Instruction deduplication — avoid repeating the same speech
  lastSpokenInstruction: string;
  lastInstructionAt: number; // timestamp ms
  // Track total raw steps across all segments for reliable counting
  totalRawSteps: number;
  // Reference images per room (roomId → array of {compassHeading, imageData, locationTag})
  // Populated at navigation start so advanceSegment can trigger visual verification
  roomReferenceImages?: Map<string, Array<{ compassHeading: number; imageData: string; locationTag: string }>>;
}

// Database model (matches Prisma schema)
export interface NavigationSession {
  id: string;
  userId: string;
  flatMapId: string;
  status: string; // SessionStatus as string
  destinationRoomId: string;
  pathJson: string; // JSON string, parse to PathSegment[]
  currentSegmentIndex: number;
  currentRoomId: string;
  estimatedPositionX: number;
  estimatedPositionY: number;
  currentCompassHeading: number;
  confidence: number;
  stepsTakenInSegment: number;
  totalStepsInSegment: number;
  triggeredCheckpoints: string; // JSON string, parse to string[]
  lastVisualConfirmAt: Date | null;
  lastConfirmedRoomId: string | null;
  pendingVisualRequest: boolean;
  startedAt: Date;
  lastUpdateAt: Date;
  completedAt: Date | null;
}

export interface NavigationSessionWithRelations extends NavigationSession {
  user?: User;
  flatMap?: FlatMap;
}

// Helper type for creating navigation sessions
export interface CreateNavigationSessionInput {
  userId: string;
  flatMapId: string;
  destinationRoomId: string;
  currentRoomId: string;
  estimatedPositionX: number;
  estimatedPositionY: number;
  currentCompassHeading: number;
  path: PathSegment[];
}

// Helper type for updating navigation sessions
export interface UpdateNavigationSessionInput {
  status?: SessionStatus;
  currentSegmentIndex?: number;
  currentRoomId?: string;
  estimatedPositionX?: number;
  estimatedPositionY?: number;
  currentCompassHeading?: number;
  confidence?: number;
  stepsTakenInSegment?: number;
  totalStepsInSegment?: number;
  triggeredCheckpoints?: string[];
  lastVisualConfirmAt?: Date | null;
  lastConfirmedRoomId?: string | null;
  pendingVisualRequest?: boolean;
  path?: PathSegment[];
  completedAt?: Date | null;
}

// Import types that will be defined in other files
import type { User } from './User.js';
import type { FlatMap } from './FlatMap.js';
