// Role checks for write endpoints.
//
// Stage 2 (accounts and permissions) owns authentication. Until it lands, createApp() uses
// developmentUser, which acts as a local admin so the catalogue and subscriptions can be used.
// Stage 2 should pass its own `authenticate(req, db)` to createApp(db, { authenticate }) that
// returns { id, role } for the signed-in user, or null when nobody is signed in.
import { HttpError } from './http.js';

export const developmentUser = Object.freeze({ id: null, role: 'admin', development: true });

export function requireRole(user, ...roles) {
  if (!user) throw new HttpError(401, 'Sign in to continue.');
  if (!roles.includes(user.role)) throw new HttpError(403, 'You do not have permission to perform this action.');
  return user;
}

export const ADMIN = ['admin'];
export const TEAM = ['admin', 'staff'];
