export interface FlatMapOrigin {
  description: string;
  compassHeading: number;
}

export interface FlatMap {
  id: string;
  userId: string;
  name: string;
  origin: string; // JSON string, parse to FlatMapOrigin
  createdAt: Date;
  updatedAt: Date;
}

export interface FlatMapWithRelations extends FlatMap {
  user?: User;
  rooms?: Room[];
  navigationSessions?: NavigationSession[];
}

// Helper type for creating flat maps
export interface CreateFlatMapInput {
  userId: string;
  name: string;
  origin: FlatMapOrigin;
}

// Helper type for updating flat maps
export interface UpdateFlatMapInput {
  name?: string;
  origin?: FlatMapOrigin;
}

// Import types that will be defined in other files
import type { User } from './User';
import type { Room } from './Room';
import type { NavigationSession } from './NavigationSession';
