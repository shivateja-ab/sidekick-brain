/**
 * Application Configuration
 * 
 * Loads and validates environment variables.
 */
export const config = {
  // Database
  DATABASE_URL: process.env.DATABASE_URL || 'file:./dev.db',

  // JWT Authentication
  JWT_SECRET: process.env.JWT_SECRET || (() => {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('JWT_SECRET is required in production');
    }
    return 'dev-secret-change-in-production';
  })(),

  // Vision API
  VISION_API_URL: process.env.VISION_API_URL || '',

  // Server
  PORT: parseInt(process.env.PORT || '3000', 10),
  NODE_ENV: process.env.NODE_ENV || 'development',

  // CORS
  CORS_ORIGIN: process.env.CORS_ORIGIN || '*',
};

// Validate required config in production
if (config.NODE_ENV === 'production') {
  if (!config.JWT_SECRET || config.JWT_SECRET === 'dev-secret-change-in-production') {
    throw new Error('JWT_SECRET must be set in production');
  }
  if (!config.VISION_API_URL) {
    throw new Error('VISION_API_URL must be set in production');
  }
}
