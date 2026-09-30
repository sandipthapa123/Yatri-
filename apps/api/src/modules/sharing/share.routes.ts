import { randomBytes } from 'node:crypto';

import {
  SHARE_TOKEN_PATTERN,
  describeShareView,
  type ApiResponse,
  type ShareView,
} from '@yatri/types';
import { Router, type Request, type Response, type Router as RouterType } from 'express';

import { ipRateLimit } from '../../middleware/rateLimit';
import { renderSharePage } from './share.page';
import { shareViewForToken } from './sharing.service';

/**
 * The PUBLIC side of trip sharing: no sign-in, the link itself is the credential. Every failure —
 * malformed, unknown, stopped, expired, ended — is the same 404, so a link cannot be probed, and
 * nothing here is cached, indexed or leaked through a referrer.
 */
export const shareRouter: RouterType = Router();

shareRouter.use(ipRateLimit('share', 120, 60));
shareRouter.use((_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  next();
});

const tokenOf = (req: Request): string | null => {
  const raw = req.params.token;
  const t = Array.isArray(raw) ? raw[0] : raw;
  return t && SHARE_TOKEN_PATTERN.test(t) ? t : null;
};

async function viewFor(req: Request): Promise<ShareView | null> {
  const token = tokenOf(req);
  return token ? shareViewForToken(token) : null;
}

shareRouter.get(
  '/:token/data',
  async (
    req: Request,
    res: Response<ApiResponse<{ view: ShareView; headline: string; details: string[] }>>,
  ) => {
    const view = await viewFor(req);
    if (!view) {
      res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'This link is not available.' },
      });
      return;
    }
    res.json({ success: true, data: { view, ...describeShareView(view) } });
  },
);

shareRouter.get('/:token', async (req: Request, res: Response) => {
  const view = await viewFor(req);
  const nonce = randomBytes(16).toString('base64');
  // Only this page's own inline style/script (by nonce) and calls back to this same host.
  res.setHeader(
    'Content-Security-Policy',
    `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
  );
  res
    .status(view ? 200 : 404)
    .type('html')
    .send(renderSharePage(tokenOf(req) ?? '', view, nonce));
});
