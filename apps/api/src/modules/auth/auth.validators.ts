import { z } from 'zod';

export const phoneNumberSchema = z
  .string()
  .trim()
  .regex(/^\+[1-9]\d{6,14}$/, 'Phone number must be in E.164 format, e.g. +9779800000000');

export const passengerOrDriverRoleSchema = z.enum(['PASSENGER', 'DRIVER']);

export const requestOtpSchema = z.object({
  phoneNumber: phoneNumberSchema,
  role: passengerOrDriverRoleSchema,
});

export const verifyOtpSchema = z.object({
  phoneNumber: phoneNumberSchema,
  role: passengerOrDriverRoleSchema,
  code: z
    .string()
    .trim()
    .regex(/^\d{4,8}$/, 'Code must be numeric'),
});

export const refreshSchema = z.object({
  refreshToken: z.string().min(1),
});

export const logoutSchema = z.object({
  allDevices: z.boolean().optional().default(false),
});

export const adminLoginSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1),
});
