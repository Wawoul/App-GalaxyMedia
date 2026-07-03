import jwt from 'jsonwebtoken';
import { config, ACCESS_TOKEN_TTL_S, PENDING_2FA_TTL_S } from '../config.js';

export interface UserTokenClaims {
  sub: string; // user id
  typ: 'user';
}

export interface Pending2faClaims {
  sub: string;
  typ: '2fa'; // password verified, awaiting TOTP
  enroll: boolean; // true when the user must enroll first
}

export interface DeviceTokenClaims {
  sub: string; // screen id
  typ: 'device';
  jti: string; // matches screens.device_token_jti; revoking = clearing that column
}

type Claims = UserTokenClaims | Pending2faClaims | DeviceTokenClaims;

export function signUserToken(userId: string): string {
  const claims: UserTokenClaims = { sub: userId, typ: 'user' };
  return jwt.sign(claims, config.JWT_SECRET, { expiresIn: ACCESS_TOKEN_TTL_S });
}

export function signPending2fa(userId: string, enroll: boolean): string {
  const claims: Pending2faClaims = { sub: userId, typ: '2fa', enroll };
  return jwt.sign(claims, config.JWT_SECRET, { expiresIn: PENDING_2FA_TTL_S });
}

export function signDeviceToken(screenId: string, jti: string): string {
  const claims: DeviceTokenClaims = { sub: screenId, typ: 'device', jti };
  // Long-lived: revocation is via the jti column, not expiry.
  return jwt.sign(claims, config.JWT_SECRET, { expiresIn: '5y' });
}

export function verifyToken(token: string): Claims | null {
  try {
    return jwt.verify(token, config.JWT_SECRET) as Claims;
  } catch {
    return null;
  }
}
