// src/controlPanel/auth.js
import bcrypt from 'bcryptjs'
import crypto from 'node:crypto'

const MAX_ATTEMPTS = 5
const LOCKOUT_MS = 15 * 60 * 1000

const attempts = new Map() // ip -> { count, lockedUntil }

export function isLockedOut(ip) {
    const rec = attempts.get(ip)
    if (!rec) return false
    if (rec.lockedUntil && Date.now() < rec.lockedUntil) return true
    if (rec.lockedUntil && Date.now() >= rec.lockedUntil) {
        attempts.delete(ip)
        return false
    }
    return false
}

export function recordFailure(ip) {
    const rec = attempts.get(ip) ?? { count: 0, lockedUntil: null }
    rec.count += 1
    if (rec.count >= MAX_ATTEMPTS) {
        rec.lockedUntil = Date.now() + LOCKOUT_MS
    }
    attempts.set(ip, rec)
}

export function recordSuccess(ip) {
    attempts.delete(ip)
}

export async function verifyPassword(plain, hash) {
    if (!plain || !hash) return false
    return bcrypt.compare(plain, hash)
}

export function verifyUsername(username, expected) {
    if (!username || !expected) return false
    // constant-time compare
    const a = Buffer.from(username)
    const b = Buffer.from(expected)
    if (a.length !== b.length) return false
    return crypto.timingSafeEqual(a, b)
}

export function newCsrfToken() {
    return crypto.randomBytes(24).toString('hex')
}