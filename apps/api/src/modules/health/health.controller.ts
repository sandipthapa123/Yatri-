import type { Request, Response } from 'express';
import type { ApiResponse } from '@yatri/types';

interface HealthPayload {
  status: 'ok';
  uptimeSeconds: number;
  timestamp: string;
}

export function getHealth(_req: Request, res: Response<ApiResponse<HealthPayload>>) {
  res.json({
    success: true,
    data: {
      status: 'ok',
      uptimeSeconds: Math.round(process.uptime()),
      timestamp: new Date().toISOString(),
    },
  });
}
