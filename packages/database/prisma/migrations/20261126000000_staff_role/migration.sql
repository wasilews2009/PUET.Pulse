-- Ordinary employee role: staff basics without moderation or consultation hosting.
ALTER TYPE "RoleCode" ADD VALUE IF NOT EXISTS 'STAFF';
