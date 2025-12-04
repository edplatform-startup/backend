import { getSupabase } from '../supabaseClient.js';

/**
 * JWT Authentication Middleware
 * 
 * Validates the Authorization header contains a valid Supabase JWT token.
 * On success, attaches the authenticated user to req.user.
 * 
 * Usage:
 * - Clients must include: Authorization: Bearer <supabase_jwt_token>
 * - The token is validated against Supabase Auth
 * - The authenticated user's ID and email are attached to req.user
 */
export async function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader) {
    return res.status(401).json({
      error: 'Authorization header is required',
      details: 'Include a valid JWT token in the Authorization header: Bearer <token>'
    });
  }

  if (!authHeader.startsWith('Bearer ')) {
    return res.status(401).json({
      error: 'Invalid authorization format',
      details: 'Authorization header must be in format: Bearer <token>'
    });
  }

  const token = authHeader.slice(7); // Remove 'Bearer ' prefix

  if (!token || token.trim() === '') {
    return res.status(401).json({
      error: 'Token is required',
      details: 'A valid JWT token must be provided after Bearer'
    });
  }

  try {
    const supabase = getSupabase();
    const { data: { user }, error } = await supabase.auth.getUser(token);

    if (error) {
      console.error('JWT verification failed:', error.message);
      return res.status(401).json({
        error: 'Invalid or expired token',
        details: error.message
      });
    }

    if (!user) {
      return res.status(401).json({
        error: 'Invalid token',
        details: 'Token did not resolve to a valid user'
      });
    }

    // Attach user info to request for downstream handlers
    req.user = {
      id: user.id,
      email: user.email,
      role: user.role,
      metadata: user.user_metadata
    };

    next();
  } catch (error) {
    console.error('Auth middleware error:', error);
    return res.status(500).json({
      error: 'Authentication service error',
      details: error.message
    });
  }
}

/**
 * Optional Auth Middleware
 * 
 * Similar to requireAuth but doesn't fail if no token is provided.
 * Useful for endpoints that can work with or without authentication.
 */
export async function optionalAuth(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    req.user = null;
    return next();
  }

  const token = authHeader.slice(7);

  if (!token || token.trim() === '') {
    req.user = null;
    return next();
  }

  try {
    const supabase = getSupabase();
    const { data: { user }, error } = await supabase.auth.getUser(token);

    if (error || !user) {
      req.user = null;
    } else {
      req.user = {
        id: user.id,
        email: user.email,
        role: user.role,
        metadata: user.user_metadata
      };
    }

    next();
  } catch (error) {
    console.error('Optional auth middleware error:', error);
    req.user = null;
    next();
  }
}
