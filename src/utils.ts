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
const TOKEN_REFRESH_MARGIN = 60 * 1000; // Refrescar token si expira en menos de 60 segundos (1 minuto)

export interface SpotifyConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  accessToken?: string;
  refreshToken?: string;
  expires_at?: number; // Timestamp Unix (milisegundos) cuando expira el token de acceso
}

export function loadSpotifyConfig(): SpotifyConfig {
  if (!fs.existsSync(CONFIG_FILE)) {
    throw new Error(
      `Spotify configuration file not found at ${CONFIG_FILE}.\nPlease run 'npm run auth' first or create the file manually with clientId, clientSecret, and redirectUri.\nExample: {\n  "clientId": "YOUR_CLIENT_ID",\n  "clientSecret": "YOUR_CLIENT_SECRET",\n  "redirectUri": "http://127.0.0.1:4321/callback"\n}`
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

async function exchangeCodeForToken(
  code: string,
  config: SpotifyConfig
): Promise<{
  access_token: string;
  refresh_token: string;
  expires_in: number;
}> {
  const tokenUrl = `${SPOTIFY_ACCOUNTS_BASE}/api/token`; // SPOTIFY_ACCOUNTS_BASE debe estar definido
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
async function refreshToken(config: SpotifyConfig): Promise<SpotifyConfig> {
  if (!config.refreshToken) {
    throw new Error(
      "No refresh token available. Please run `npm run auth` again."
    );
  }

  const tokenUrl = `${SPOTIFY_ACCOUNTS_BASE}/api/token`;
  const authHeader = `Basic ${Buffer.from(
    // Usar Buffer para base64 en Node.js
    `${config.clientId}:${config.clientSecret}`
  ).toString("base64")}`;

  const params = new URLSearchParams();
  params.append("grant_type", "refresh_token");
  params.append("refresh_token", config.refreshToken);
  params.append("client_id", config.clientId);

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
    // Si el refresh token es inválido, el usuario DEBE re-autenticarse
    if (response.status === 400 || response.status === 401) {
      throw new Error(
        `Spotify refresh token failed (${response.status}). Please run \`npm run auth\` again.`
      );
    }
    throw new Error(`Failed to refresh token: ${response.status}`);
  }

  const data = await response.json();

  // Asegurarse de que data.expires_in existe
  if (typeof data.expires_in !== "number") {
    throw new Error("Token refresh response missing expires_in");
  }

  // Actualizar y guardar la configuración con el nuevo token
  config.accessToken = data.access_token;
  // Spotify PUEDE devolver un nuevo refresh token. Si lo hace, guardarlo.
  if (data.refresh_token) {
    config.refreshToken = data.refresh_token;
    console.error("Received a new refresh token from Spotify."); // Log a stderr
  }
  config.expires_at = Date.now() + data.expires_in * 1000; // Calcular NUEVO timestamp de expiración
  saveSpotifyConfig(config);

  console.error("Spotify token refreshed successfully."); // Log a stderr
  return config;
}

// Función genérica para manejar peticiones API con refresco ---
export async function handleSpotifyRequest<T>(
  method: string,
  path: string,
  queryParams?: Record<string, any>,
  body?: any,
  retryOnAuthError = true // Permitir reintentar una vez en caso de 401
): Promise<T | undefined> {
  let config = loadSpotifyConfig();

  if (!config.accessToken) {
    throw new Error(
      "Spotify authentication required. Please run `npm run auth` first."
    );
  }

  // 2. Verificar si el token ha expirado o está a punto de expirar
  if (
    config.expires_at && // Asegurarse de que expires_at existe
    config.expires_at < Date.now() + TOKEN_REFRESH_MARGIN // Comparar con margen
  ) {
    console.error(
      "Spotify token expired or near expiry, attempting refresh..."
    ); // Log a stderr
    try {
      // Intentar refrescar ANTES de la llamada
      config = await refreshToken(config); // Actualiza config con nuevos tokens/expiración
    } catch (refreshError) {
      // Si el refresco falla, lanzar el error claro
      console.error("Initial token refresh failed:", refreshError); // Log a stderr
      throw refreshError; // Re-lanzar el error (que ya debería ser user-friendly)
    }
  }

  // 3. Preparar y hacer la llamada API
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
        "Spotify API returned 401 Unauthorized. Attempting to refresh token and retry..." // Log a stderr
      );
      try {
        await refreshToken(config);
        console.error("Retrying Spotify API request after token refresh...");
        return handleSpotifyRequest<T>(method, path, queryParams, body, false);
      } catch (refreshError) {
        console.error("Token refresh failed on retry after 401:", refreshError); // Log a stderr
        throw new Error(
          "Spotify authentication expired or invalid refresh token. Please run `npm run auth` again."
        );
      }
    } else {
      let errorText = await response.text();
      try {
        const errorJson: SpotifyApiError = JSON.parse(errorText);
        errorText = errorJson.error?.message || errorText; // Usar mensaje de error de Spotify si existe
      } catch (e) {}
      throw new Error(`Spotify API Error (${response.status}): ${errorText}`);
    }
  }

  if (response.status === 204) {
    return undefined;
  }

  if (response.status === 200 || response.status === 201) {
    try {
      const responseData = await response.json();
      return responseData as T;
    } catch (error) {
      if (response.status === 200) return undefined;
      console.error("Failed to parse Spotify API response JSON:", error);
      if (response.status >= 200 && response.status < 300) {
        throw new Error(
          `Failed to parse Spotify API response JSON for status ${response.status}. Expected JSON for ${method} ${path}`
        );
      }
      return undefined;
    }
  }

  // Para otros códigos 2xx (ej. 202 Accepted) que no suelen tener cuerpo JSON
  console.error(
    `Spotify API returned status ${response.status} for ${method} ${path}, returning undefined.`
  ); // Log a stderr
  return undefined;
}
export async function authorizeSpotify(): Promise<void> {
  const config = loadSpotifyConfig(); // Cargar config para clientId, etc.

  const redirectUri = new URL(config.redirectUri);
  const port = redirectUri.port || "4321";
  if (
    redirectUri.hostname !== "localhost" &&
    redirectUri.hostname !== "127.0.0.1"
  ) {
    console.error(
      "Error: Redirect URI must use localhost for automatic token exchange"
    );
    console.error("Example: http://127.0.0.1:4321/callback");
  }
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
    show_dialog: "true",
  });

  const authorizationUrl = `${SPOTIFY_ACCOUNTS_BASE}/authorize?${authParams.toString()}`;

  const authPromise = new Promise<void>((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      // ... (Manejo del callback como lo tenías, asegurándose de llamar a exchangeCodeForToken) ...
      if (!req.url) {
        res.writeHead(400).end("No URL provided");
        server.close(() => reject(new Error("Request had no URL"))); // Rechazar al cerrar
        return;
      }

      const reqUrl = new URL(req.url, `http://localhost:${port}`); // Usar http

      if (reqUrl.pathname === callbackPath) {
        const code = reqUrl.searchParams.get("code");
        const returnedState = reqUrl.searchParams.get("state");
        const error = reqUrl.searchParams.get("error");

        res.writeHead(200, { "Content-Type": "text/html" });

        if (error) {
          console.error(`Authorization error: ${error}`); // Log a stderr
          res.end(
            `<html><body><h1>Authentication Failed</h1><p>Error: ${error}. Please close this window.</p></body></html>`
          );
          server.close(() =>
            reject(new Error(`Authorization failed: ${error}`))
          ); // Rechazar al cerrar
          return;
        }

        if (returnedState !== state) {
          console.error("State mismatch error"); // Log a stderr
          res.end(
            "<html><body><h1>Authentication Failed</h1><p>State verification failed. Please close this window and try again.</p></body></html>"
          );
          server.close(() => reject(new Error("State mismatch"))); // Rechazar al cerrar
          return;
        }

        if (!code) {
          console.error("No authorization code received"); // Log a stderr
          res.end(
            "<html><body><h1>Authentication Failed</h1><p>No authorization code received. Please close this window and try again.</p></body></html>"
          );
          server.close(() =>
            reject(new Error("No authorization code received"))
          ); // Rechazar al cerrar
          return;
        }

        try {
          const currentConfig = loadSpotifyConfig(); // Cargar config fresca
          // Intercambiar código por tokens
          const tokens = await exchangeCodeForToken(code, currentConfig);
          currentConfig.accessToken = tokens.access_token;
          currentConfig.refreshToken = tokens.refresh_token;
          currentConfig.expires_at = Date.now() + tokens.expires_in * 1000;
          saveSpotifyConfig(currentConfig);

          res.end(
            "<html><body><h1>Authentication Successful!</h1><p>You can now close this window and return to the application.</p></body></html>"
          );
          console.error("Authentication successful! Tokens saved."); // Log a stderr

          server.close(() => resolve());
        } catch (exchangeError) {
          console.error("Token exchange error:", exchangeError); // Log a stderr
          res.end(
            "<html><body><h1>Authentication Failed</h1><p>Failed to exchange authorization code for tokens. Please check logs and try again.</p></body></html>"
          );
          server.close(() => reject(exchangeError)); // Rechazar al cerrar
        }
      } else {
        res.writeHead(404).end();
      }
    });

    server.listen(Number.parseInt(port, 10), "127.0.0.1", () => {
      console.error(
        // Log a stderr
        `Listening for Spotify callback on http://127.0.0.1:${port}${callbackPath}`
      );
      console.error("Opening browser for authorization..."); // Log a stderr
      open(authorizationUrl).catch((openError: Error) => {
        console.error(
          "Failed to open browser automatically. Please visit this URL manually to authorize:"
        );
        console.error(authorizationUrl); // Log a stderr
      });
    });

    server.on("error", (serverError) => {
      console.error(
        `HTTP server error during auth flow: ${serverError.message}`
      ); // Log a stderr
      reject(serverError);
    });
  });

  await authPromise;
}

// Helper para generar strings aleatorios (ya lo tenías)
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

export function formatDuration(ms: number): string {
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.round((ms % 60000) / 1000);
  if (seconds === 60) {
    return `${minutes + 1}:00`;
  }
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}
