/**
 * Access-token parameters, shared by everything that signs or verifies one (the API, and the admin
 * app's edge check). Pinning the algorithm stops an attacker choosing a weaker one in the token
 * header; the issuer stops a token minted for something else being accepted here.
 */
export const ACCESS_TOKEN_ALGORITHM = 'HS256' as const;
export const ACCESS_TOKEN_ISSUER = 'yatri-api';

/** The header that carries a request's correlation id (accepted from a caller only if well formed). */
export const REQUEST_ID_HEADER = 'x-request-id';
