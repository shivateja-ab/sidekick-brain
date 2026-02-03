export interface UserPreferences {
  voiceSpeed: number;
  verbosity: 'minimal' | 'normal' | 'detailed';
  stepLengthCm: number;
}

export interface User {
  id: string;
  email: string;
  name: string;
  password: string;
  preferences: string; // JSON string, parse to UserPreferences
  createdAt: Date;
  updatedAt: Date;
}

export interface UserWithRelations extends User {
  flatMaps?: FlatMap[];
  navigationSessions?: NavigationSession[];
}

// Helper type for creating users (without id, timestamps)
export interface CreateUserInput {
  email: string;
  name: string;
  password: string;
  preferences?: Partial<UserPreferences>;
}

// Helper type for updating users
export interface UpdateUserInput {
  email?: string;
  name?: string;
  password?: string;
  preferences?: Partial<UserPreferences>;
}

// Import types that will be defined in other files
import type { FlatMap } from './FlatMap';
import type { NavigationSession } from './NavigationSession';
