export type RoomType = 
  | 'bedroom'
  | 'bathroom'
  | 'kitchen'
  | 'living_room'
  | 'dining_room'
  | 'corridor'
  | 'hallway'
  | 'office'
  | 'storage'
  | 'other';

export interface Room {
  id: string;
  flatMapId: string;
  type: string; // RoomType as string
  name: string;
  positionX: number;
  positionY: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface RoomWithRelations extends Room {
  flatMap?: FlatMap;
  doorways?: Doorway[];
  incomingDoorways?: Doorway[];
  landmarks?: Landmark[];
  referenceImages?: ReferenceImage[];
}

// Helper type for creating rooms
export interface CreateRoomInput {
  flatMapId: string;
  type: RoomType | string;
  name: string;
  positionX: number;
  positionY: number;
}

// Helper type for updating rooms
export interface UpdateRoomInput {
  type?: RoomType | string;
  name?: string;
  positionX?: number;
  positionY?: number;
}

// Import types that will be defined in other files
import type { FlatMap } from './FlatMap';
import type { Doorway } from './Doorway';
import type { Landmark } from './Landmark';
import type { ReferenceImage } from './ReferenceImage';
