// src/utils.ts
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath, URL, URLSearchParams } from "node:url";
import open from "open";

import type { SpotifyApiError } from "./types.js"; // Asegúrate de que se exporte en types.ts

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_FILE = path.join(__dirname, "../spotify-config.json");
const SPOTIFY_API_BASE = "https://api.spotify.com";
const SPOTIFY_ACCOUNTS_BASE = "https://accounts.spotify.com";
const TOKEN_REFRESH_MARGIN = 60 * 1000; // Refrescar token si expira en menos de 60 segundos

export interface SpotifyConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  accessToken?: string;
  refreshToken?: string;
  expires_at?: number; // Timestamp Unix cuando expira el token de acceso
}

export function loadSpotifyConfig(): SpotifyConfig {
  if (!fs.existsSync(CONFIG_FILE)) {
    throw new Error(
      `Spotify configuration file not found at ${CONFIG_FILE}.\nPlease create one with clientId, clientSecret, and redirectUri.\nExample: {\n  "clientId": "YOUR_CLIENT_ID",\n  "clientSecret": "YOUR_CLIENT_SECRET",\n  "redirectUri": "http://127.0.0.1:4321/callback"\n}`
    );
  }

  try {
    const config = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
    if (!config.clientId || !config.clientSecret || !config.redirectUri) {
      throw new Error(
        "Spotify configuration must include clientId, clientSecret, and redirectUri."
      );
    }
    return config;
  } catch (error) {
    throw new Error(
      `Failed to parse Spotify configuration: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

export function saveSpotifyConfig(config: SpotifyConfig): void {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), "utf8");
}

// Función para intercambiar código de autorización por tokens (ESTA FUNCIÓN SÍ EXISTE AQUÍ)
async function exchangeCodeForToken(
  code: string,
  config: SpotifyConfig
): Promise<{
  access_token: string;
  refresh_token: string;
  expires_in: number;
}> {
  // Añadir expires_in al tipo de retorno
  const tokenUrl = `${SPOTIFY_ACCOUNTS_BASE}/api/token`;
  const authHeader = `Basic ${Buffer.from(
    `${config.clientId}:${config.clientSecret}`
  ).toString("base64")}`;

  const params = new URLSearchParams();
  params.append("grant_type", "authorization_code");
  params.append("code", code);
  params.append("redirect_uri", config.redirectUri);

  console.error("Attempting to exchange code for token..."); // Log a stderr

  const response = await fetch(tokenUrl, {
    method: "POST",
    headers: {
      Authorization: authHeader,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params,
  });

  if (!response.ok) {
    const errorData = await response.text();
    console.error(
      `Failed to exchange code for token: ${response.status} - ${errorData}`
    ); // Log a stderr
    throw new Error(`Failed to exchange code for token: ${response.status}`);
  }

  const data = await response.json();
  // Asegurarse de que data.expires_in existe
  if (typeof data.expires_in !== "number") {
    throw new Error("Token exchange response missing expires_in");
  }
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_in: data.expires_in, // Devolver expires_in también
  };
}

// Función para refrescar el token de acceso
async function refreshToken(config: SpotifyConfig): Promise<SpotifyConfig> {
  if (!config.refreshToken) {
    throw new Error("No refresh token available. User needs to re-authorize.");
  }

  const tokenUrl = `${SPOTIFY_ACCOUNTS_BASE}/api/token`;
  const authHeader = `Basic ${Buffer.from(
    `${config.clientId}:${config.clientSecret}`
  ).toString("base64")}`; // Usar Buffer para base64

  const params = new URLSearchParams();
  params.append("grant_type", "refresh_token");
  params.append("refresh_token", config.refreshToken);
  params.append("client_id", config.clientId); // Spotify requiere client_id también para refresh

  console.error("Attempting to refresh Spotify token..."); // Log a stderr

  const response = await fetch(tokenUrl, {
    method: "POST",
    headers: {
      Authorization: authHeader,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params,
  });

  if (!response.ok) {
    const errorData = await response.text();
    console.error(`Failed to refresh token: ${response.status} - ${errorData}`); // Log a stderr
    throw new Error(`Failed to refresh token: ${response.status}`);
  }

  const data = await response.json();

  // Asegurarse de que data.expires_in existe
  if (typeof data.expires_in !== "number") {
    throw new Error("Token refresh response missing expires_in");
  }

  // Actualizar y guardar la configuración con el nuevo token
  config.accessToken = data.access_token;
  // Puede que el refresh token cambie o no. Si viene, lo guardamos.
  if (data.refresh_token) {
    config.refreshToken = data.refresh_token;
  }
  config.expires_at = Date.now() + data.expires_in * 1000; // Calcular timestamp de expiración
  saveSpotifyConfig(config);

  console.error("Spotify token refreshed successfully."); // Log a stderr
  return config;
}

// Función genérica para manejar las peticiones a la API de Spotify
export async function handleSpotifyRequest<T>(
  method: string,
  path: string,
  queryParams?: Record<string, any>,
  body?: any,
  retryOnAuthError = true
): Promise<T | undefined> {
  let config = loadSpotifyConfig();

  if (!config.accessToken) {
    throw new Error(
      "Spotify authentication required. Please run `npm run auth` first."
    );
  }

  if (
    config.expires_at &&
    config.expires_at < Date.now() + TOKEN_REFRESH_MARGIN
  ) {
    try {
      config = await refreshToken(config);
    } catch (refreshError) {
      if (retryOnAuthError) {
        console.error(
          "Refresh token failed before API request. User needs to re-authorize."
        );
        throw new Error(
          "Spotify authentication expired. Please run `npm run auth` again."
        );
      } else {
        throw refreshError;
      }
    }
  }

  const url = new URL(path, SPOTIFY_API_BASE);
  if (queryParams) {
    const validQueryParams = Object.entries(queryParams)
      .filter(([_, value]) => value !== undefined && value !== null)
      .reduce((acc, [key, value]) => {
        if (Array.isArray(value)) {
          acc[key] = value.join(",");
        } else {
          acc[key] = String(value);
        }
        return acc;
      }, {} as Record<string, string>);

    url.search = new URLSearchParams(validQueryParams).toString();
  }

  console.error(`Spotify API Request: ${method} ${url.toString()}`);
  if (body !== undefined) {
    console.error("Body:", JSON.stringify(body));
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${config.accessToken}`,
  };
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
  }

  const response = await fetch(url.toString(), {
    method: method,
    headers: headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  if (!response.ok) {
    if (response.status === 401 && retryOnAuthError) {
      console.error(
        "Spotify API returned 401 Unauthorized. Attempting to refresh token and retry..."
      );
      try {
        await refreshToken(config);
        console.error("Retrying Spotify API request after token refresh...");
        return handleSpotifyRequest<T>(method, path, queryParams, body, false);
      } catch (refreshError) {
        console.error("Token refresh failed on retry after 401.");
        throw new Error(
          "Spotify authentication expired or invalid refresh token. Please run `npm run auth` again."
        );
      }
    } else {
      let errorText = await response.text();
      try {
        const errorJson: SpotifyApiError = JSON.parse(errorText);
        errorText = errorJson.error?.message || errorText;
      } catch (e) {
        // Ignorar errores de parseo si el cuerpo no es JSON
      }
      throw new Error(`Spotify API Error (${response.status}): ${errorText}`);
    }
  }

  if (response.status === 204) {
    return undefined;
  }

  try {
    // Only attempt to parse JSON if a body is expected for this status/method
    return (await response.json()) as T;
  } catch (error) {
    console.error("Failed to parse Spotify API response JSON:", error);
    if (response.status === 200) return undefined;

    if (
      response.status >= 200 &&
      response.status < 300 &&
      response.status !== 204 // and now not the specific PUT /me/tracks 200 case
    ) {
      throw new Error(
        `Failed to parse Spotify API response JSON for status ${response.status}. Expected JSON for ${method} ${path}`
      );
    }
    // Otherwise, maybe a 200 with empty body or similar unexpected but non-critical issue, return undefined
    return undefined;
  }
}

export async function authorizeSpotify(): Promise<void> {
  const config = loadSpotifyConfig();

  const redirectUri = new URL(config.redirectUri);
  if (
    redirectUri.hostname !== "localhost" &&
    redirectUri.hostname !== "127.0.0.1"
  ) {
    console.error(
      "Error: Redirect URI must use localhost for automatic token exchange"
    );
    console.error("Example: http://127.0.0.1:4321/callback");
    // Dependiendo de si quieres que el servidor falle si la URI no es localhost,
    // podrías lanzar un error aquí en lugar de solo loguear.
    // throw new Error("Redirect URI must be localhost");
  }

  const port = redirectUri.port || "4321";
  const callbackPath = redirectUri.pathname || "/callback";

  const state = generateRandomString(16);

  const scopes = [
    "user-read-private",
    "user-read-email",
    "user-read-playback-state",
    "user-modify-playback-state",
    "user-read-currently-playing",
    "playlist-read-private",
    "playlist-modify-private",
    "playlist-modify-public",
    "user-library-read",
    "user-library-modify",
    "user-read-recently-played",
    "user-follow-read",
    "user-follow-modify",
  ];

  const authParams = new URLSearchParams({
    client_id: config.clientId,
    response_type: "code",
    redirect_uri: config.redirectUri,
    scope: scopes.join(" "),
    state: state,
    // show_dialog: "true", // Opcional: forzar al usuario a re-autorizar y ver scopes
  });

  const authorizationUrl = `${SPOTIFY_ACCOUNTS_BASE}/authorize?${authParams.toString()}`;

  const authPromise = new Promise<void>((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      if (!req.url) {
        res.writeHead(400).end("No URL provided");
        server.close();
        return;
      }

      const reqUrl = new URL(req.url, `http://localhost:${port}`);

      if (reqUrl.pathname === callbackPath) {
        const code = reqUrl.searchParams.get("code");
        const returnedState = reqUrl.searchParams.get("state");
        const error = reqUrl.searchParams.get("error");

        res.writeHead(200, { "Content-Type": "text/html" });

        if (error) {
          console.error(`Authorization error: ${error}`);
          res.end(
            `<html><body><h1>Authentication Failed</h1><p>Error: ${error}. Please close this window.</p></body></html>`
          );
          server.close();
          reject(new Error(`Authorization failed: ${error}`));
          return;
        }

        if (returnedState !== state) {
          console.error("State mismatch error");
          res.end(
            "<html><body><h1>Authentication Failed</h1><p>State verification failed. Please close this window and try again.</p></body></html>"
          );
          server.close();
          reject(new Error("State mismatch"));
          return;
        }

        if (!code) {
          console.error("No authorization code received");
          res.end(
            "<html><body><h1>Authentication Failed</h1><p>No authorization code received. Please close this window and try again.</p></body></html>"
          );
          server.close();
          reject(new Error("No authorization code received"));
          return;
        }

        try {
          // Usar la función exchangeCodeForToken
          const tokens = await exchangeCodeForToken(code, loadSpotifyConfig()); // Cargar config fresca

          // Actualizar y guardar la configuración
          const currentConfig = loadSpotifyConfig();
          currentConfig.accessToken = tokens.access_token;
          currentConfig.refreshToken = tokens.refresh_token;
          currentConfig.expires_at = Date.now() + tokens.expires_in * 1000; // Calcular timestamp
          saveSpotifyConfig(currentConfig); // Guardar la configuración actualizada

          res.end(
            "<html><body><h1>Authentication Successful!</h1><p>You can now close this window and return to the application.</p></body></html>"
          );
          console.error(
            // Log a stderr
            "Authentication successful! Access token and refresh token have been saved."
          );

          server.close();
          resolve();
        } catch (error) {
          console.error("Token exchange error:", error); // Log a stderr
          res.end(
            "<html><body><h1>Authentication Failed</h1><p>Failed to exchange authorization code for tokens. Please close this window and try again.</p></body></html>"
          );
          server.close();
          reject(error);
        }
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    server.listen(Number.parseInt(port, 10), "127.0.0.1", () => {
      // CORRECCIÓN DEL ERROR 4 (BIOME)
      console.error(
        // Log a stderr
        `Listening for Spotify authentication callback on http://127.0.0.1:${port}${callbackPath}`
      );
      console.error("Opening browser for authorization..."); // Log a stderr
      open(authorizationUrl).catch((error: Error) => {
        console.error(
          "Failed to open browser automatically. Please visit this URL to authorize:" // Log a stderr
        );
        console.error(authorizationUrl); // Log a stderr
      });
    });

    server.on("error", (error) => {
      console.error(`HTTP server error during auth flow: ${error.message}`); // Log a stderr
      reject(error);
    });
  });

  await authPromise;
}

// Helper para generar strings aleatorios
function generateRandomString(length: number): string {
  const array = new Uint8Array(length);
  crypto.getRandomValues(array);
  return Array.from(array)
    .map((b) =>
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789".charAt(
        b % 62
      )
    )
    .join("");
}

// Función para formatear duración
export function formatDuration(ms: number): string {
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.round((ms % 60000) / 1000);
  if (seconds === 60) {
    return `${minutes + 1}:00`;
  }
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}
/*
# Currently Playing

**Track**: "Liit"
**Artist**: Çantamarta, rusowsky
**Album**: Liit
**Progress**: 0:11 / 2:47
**ID**: 6ICpIyE1WKxO8XrgokfyLr
*/
