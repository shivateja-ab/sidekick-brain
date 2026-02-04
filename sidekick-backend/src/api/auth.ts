import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { prisma } from '../db/client';
import { config } from '../config';
import type { UserPreferences } from '../models/User';

/**
 * Register request body schema
 */
interface RegisterBody {
  email: string;
  name: string;
  password: string;
}

/**
 * Login request body schema
 */
interface LoginBody {
  email: string;
  password: string;
}

/**
 * Update preferences request body schema
 */
interface UpdatePreferencesBody {
  voiceSpeed?: number;
  verbosity?: 'minimal' | 'normal' | 'detailed';
  stepLengthCm?: number;
}

/**
 * User type for authenticated requests
 */
interface AuthenticatedUser {
  userId: string;
  email: string;
}

/**
 * Helper to get authenticated user from request
 * The authenticate decorator sets request.user, but TypeScript doesn't know the type
 */
function getAuthenticatedUser(request: FastifyRequest): AuthenticatedUser | null {
  const user = (request as any).user;
  if (user && typeof user === 'object' && 'userId' in user && 'email' in user) {
    return user as AuthenticatedUser;
  }
  return null;
}

/**
 * Authenticated request type
 */
type AuthenticatedRequest = FastifyRequest;

/**
 * Hash password using bcrypt
 * 
 * @param password - Plain text password
 * @returns Hashed password
 */
async function hashPassword(password: string): Promise<string> {
  const saltRounds = 10;
  return bcrypt.hash(password, saltRounds);
}

/**
 * Compare password with hash
 * 
 * @param password - Plain text password
 * @param hash - Hashed password
 * @returns True if passwords match
 */
async function comparePassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

/**
 * Generate JWT token for user
 * 
 * @param fastify - Fastify instance
 * @param userId - User ID
 * @param email - User email
 * @returns JWT token
 */
function generateToken(fastify: FastifyInstance, userId: string, email: string): string {
  return fastify.jwt.sign(
    { userId, email },
    { expiresIn: '7d' }
  );
}

/**
 * Validate email format
 * 
 * @param email - Email to validate
 * @returns True if valid
 */
function isValidEmail(email: string): boolean {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
}

/**
 * Default user preferences
 */
const DEFAULT_PREFERENCES: UserPreferences = {
  voiceSpeed: 1.0,
  verbosity: 'normal',
  stepLengthCm: 70,
};

/**
 * Authentication routes plugin
 * 
 * Handles user registration, login, token refresh, and preferences.
 * 
 * @param fastify - Fastify instance
 */
export default async function authRoutes(fastify: FastifyInstance) {
  /**
   * POST /auth/register
   * Register a new user
   */
  fastify.post<{ Body: RegisterBody }>('/register', async (request, reply) => {
    const { email, name, password } = request.body;

    // Validation
    if (!email || !name || !password) {
      return reply.code(400).send({
        error: 'validation_error',
        message: 'Email, name, and password are required',
      });
    }

    if (!isValidEmail(email)) {
      return reply.code(400).send({
        error: 'validation_error',
        message: 'Invalid email format',
      });
    }

    if (password.length < 6) {
      return reply.code(400).send({
        error: 'validation_error',
        message: 'Password must be at least 6 characters',
      });
    }

    request.log.info(`[Auth] Registration attempt: ${email}`);

    try {
      // Check if email already exists
      const existingUser = await prisma.user.findUnique({
        where: { email: email.toLowerCase() },
      });

      if (existingUser) {
        request.log.warn(`[Auth] Registration failed: email already exists - ${email}`);
        return reply.code(409).send({
          error: 'conflict',
          message: 'Email already registered',
        });
      }

      // Hash password
      const hashedPassword = await hashPassword(password);

      // Create user with default preferences
      const user = await prisma.user.create({
        data: {
          email: email.toLowerCase(),
          name,
          password: hashedPassword,
          preferences: JSON.stringify(DEFAULT_PREFERENCES),
        },
      });

      // Generate token
      const token = generateToken(fastify, user.id, user.email);

      request.log.info(`[Auth] User registered: ${user.id}`);

      return reply.code(201).send({
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
        },
        token,
      });
    } catch (error) {
        request.log.error({ err: error }, '[Auth] Registration error');
      return reply.code(500).send({
        error: 'internal_error',
        message: 'Failed to create user',
      });
    }
  });

  /**
   * POST /auth/login
   * Login with email and password
   */
  fastify.post<{ Body: LoginBody }>('/login', async (request, reply) => {
    const { email, password } = request.body;

    // Validation
    if (!email || !password) {
      return reply.code(400).send({
        error: 'validation_error',
        message: 'Email and password are required',
      });
    }

    request.log.info(`[Auth] Login attempt: ${email}`);

    try {
      // Find user by email
      const user = await prisma.user.findUnique({
        where: { email: email.toLowerCase() },
      });

      if (!user) {
        request.log.warn(`[Auth] Login failed: user not found - ${email}`);
        return reply.code(401).send({
          error: 'unauthorized',
          message: 'Invalid credentials',
        });
      }

      // Compare password
      const isPasswordValid = await comparePassword(password, user.password);

      if (!isPasswordValid) {
        request.log.warn(`[Auth] Login failed: invalid password - ${email}`);
        return reply.code(401).send({
          error: 'unauthorized',
          message: 'Invalid credentials',
        });
      }

      // Generate token
      const token = generateToken(fastify, user.id, user.email);

      // Update last login (if field exists in schema, otherwise skip)
      // Note: This requires adding lastLoginAt to User model if needed

      request.log.info(`[Auth] User logged in: ${user.id}`);

      return reply.send({
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
        },
        token,
      });
    } catch (error) {
        request.log.error({ err: error }, '[Auth] Login error');
      return reply.code(500).send({
        error: 'internal_error',
        message: 'Failed to login',
      });
    }
  });

  /**
   * POST /auth/refresh
   * Refresh JWT token
   */
  fastify.post('/refresh', async (request: AuthenticatedRequest, reply) => {
    try {
      // Verify token (with grace period for expired tokens)
      const authHeader = request.headers.authorization;
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return reply.code(401).send({
          error: 'unauthorized',
          message: 'Missing authorization header',
        });
      }

      const token = authHeader.substring(7);

      // Try to verify token (with grace period for expired tokens)
      let decoded: { userId: string; email: string; exp?: number };
      try {
        decoded = fastify.jwt.verify(token) as { userId: string; email: string };
      } catch (error: any) {
        // If token is expired, decode without verification for grace period (24h)
        if (error.message?.includes('expired') || error.message?.includes('jwt expired')) {
          try {
            // Decode token to get payload (without verification)
            const decodedPayload = jwt.decode(token) as { userId: string; email: string; exp?: number } | null;
            
            if (!decodedPayload || !decodedPayload.userId || !decodedPayload.email) {
              return reply.code(401).send({
                error: 'unauthorized',
                message: 'Invalid token',
              });
            }

            // Check if token expired within last 24 hours (grace period)
            if (decodedPayload.exp) {
              const expirationTime = decodedPayload.exp * 1000; // Convert to milliseconds
              const now = Date.now();
              const gracePeriod = 24 * 60 * 60 * 1000; // 24 hours

              if (now - expirationTime > gracePeriod) {
                return reply.code(401).send({
                  error: 'unauthorized',
                  message: 'Token expired beyond grace period',
                });
              }
            }

            decoded = decodedPayload;
          } catch (decodeError) {
            return reply.code(401).send({
              error: 'unauthorized',
              message: 'Invalid or expired token',
            });
          }
        } else {
          return reply.code(401).send({
            error: 'unauthorized',
            message: 'Invalid token',
          });
        }
      }

      // Generate new token
      const newToken = generateToken(fastify, decoded.userId, decoded.email);

      request.log.info(`[Auth] Token refreshed: ${decoded.userId}`);

      return reply.send({
        token: newToken,
      });
    } catch (error) {
        request.log.error({ err: error }, '[Auth] Token refresh error');
      return reply.code(500).send({
        error: 'internal_error',
        message: 'Failed to refresh token',
      });
    }
  });

  /**
   * GET /auth/me
   * Get current user information (protected)
   */
  fastify.get(
    '/me',
    {
      preHandler: [(fastify as any).authenticate],
    },
    async (request: AuthenticatedRequest, reply) => {
      const authUser = getAuthenticatedUser(request);
      if (!authUser) {
        return reply.code(401).send({
          error: 'unauthorized',
          message: 'Not authenticated',
        });
      }

      try {
        const user = await prisma.user.findUnique({
          where: { id: authUser.userId},
          select: {
            id: true,
            email: true,
            name: true,
            preferences: true,
            createdAt: true,
          },
        });

        if (!user) {
          return reply.code(404).send({
            error: 'not_found',
            message: 'User not found',
          });
        }

        // Parse preferences
        let preferences: UserPreferences;
        try {
          preferences = JSON.parse(user.preferences);
        } catch {
          preferences = DEFAULT_PREFERENCES;
        }

        return reply.send({
          user: {
            id: user.id,
            email: user.email,
            name: user.name,
            preferences,
            createdAt: user.createdAt,
          },
        });
      } catch (error) {
        request.log.error({ err: error }, '[Auth] Get user error');
        return reply.code(500).send({
          error: 'internal_error',
          message: 'Failed to get user',
        });
      }
    }
  );

  /**
   * PUT /auth/preferences
   * Update user preferences (protected)
   */
  fastify.put<{ Body: UpdatePreferencesBody }>(
    '/preferences',
    {
      preHandler: [(fastify as any).authenticate],
    },
    async (request: AuthenticatedRequest, reply) => {
      const authUser = getAuthenticatedUser(request);
      if (!authUser) {
        return reply.code(401).send({
          error: 'unauthorized',
          message: 'Not authenticated',
        });
      }

      const body = request.body as UpdatePreferencesBody;
      const { voiceSpeed, verbosity, stepLengthCm } = body;

      // Validation
      if (voiceSpeed !== undefined && (voiceSpeed < 0.5 || voiceSpeed > 2.0)) {
        return reply.code(400).send({
          error: 'validation_error',
          message: 'voiceSpeed must be between 0.5 and 2.0',
        });
      }

      if (verbosity !== undefined && !['minimal', 'normal', 'detailed'].includes(verbosity)) {
        return reply.code(400).send({
          error: 'validation_error',
          message: 'verbosity must be brief, normal, or detailed',
        });
      }

      if (stepLengthCm !== undefined && (stepLengthCm < 50 || stepLengthCm > 100)) {
        return reply.code(400).send({
          error: 'validation_error',
          message: 'stepLengthCm must be between 50 and 100',
        });
      }

      try {
        // Get current user and preferences
        const user = await prisma.user.findUnique({
          where: { id: authUser.userId },
        });

        if (!user) {
          return reply.code(404).send({
            error: 'not_found',
            message: 'User not found',
          });
        }

        // Parse current preferences
        let currentPreferences: UserPreferences;
        try {
          currentPreferences = JSON.parse(user.preferences);
        } catch {
          currentPreferences = DEFAULT_PREFERENCES;
        }

        // Update preferences
        const updatedPreferences: UserPreferences = {
          voiceSpeed: voiceSpeed ?? currentPreferences.voiceSpeed,
          verbosity: verbosity ?? currentPreferences.verbosity,
          stepLengthCm: stepLengthCm ?? currentPreferences.stepLengthCm,
        };

        // Save to database
        await prisma.user.update({
          where: { id: authUser.userId },
          data: {
            preferences: JSON.stringify(updatedPreferences),
          },
        });

        request.log.info(`[Auth] Preferences updated: ${authUser.userId}`);

        return reply.send({
          preferences: updatedPreferences,
        });
      } catch (error) {
        request.log.error({ err: error }, '[Auth] Update preferences error');
        return reply.code(500).send({
          error: 'internal_error',
          message: 'Failed to update preferences',
        });
      }
    }
  );
}
