// src/utils.ts
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath, URL, URLSearchParams } from "node:url";
import open from "open";
import dotenv from "dotenv";
dotenv.config();
import type { SpotifyApiError } from "./types.js"; // Asegúrate de que se exporte en types.ts

// Usamos import.meta.url para obtener la ruta del archivo actual en módulos ES
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CONFIG_FILE = path.join(__dirname, "../spotify-config.json"); // El archivo de config estará en la raíz del proyecto

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

/**
 * Carga la configuración de Spotify. Intenta leer de variables de entorno primero
 * para clientId, clientSecret y redirectUri. Luego, carga tokens del archivo
 * de configuración si existe.
 */
export function loadSpotifyConfig(): SpotifyConfig {
  const config: SpotifyConfig = {
    clientId: process.env.SPOTIFY_CLIENT_ID || "",
    clientSecret: process.env.SPOTIFY_CLIENT_SECRET || "",
    redirectUri: process.env.SPOTIFY_REDIRECT_URI || "",
  };

  // Si el archivo de config existe, cargamos los tokens de allí
  if (fs.existsSync(CONFIG_FILE)) {
    try {
      const fileConfig = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
      // Usar tokens del archivo si existen
      if (fileConfig.accessToken) config.accessToken = fileConfig.accessToken;
      if (fileConfig.refreshToken)
        config.refreshToken = fileConfig.refreshToken;
      if (fileConfig.expires_at) config.expires_at = fileConfig.expires_at;

      // Opcional: Si las variables de entorno NO están configuradas, usar los valores del archivo
      // for clientId, etc. Esto mantiene compatibilidad con el método solo de archivo.
      if (!config.clientId && fileConfig.clientId)
        config.clientId = fileConfig.clientId;
      if (!config.clientSecret && fileConfig.clientSecret)
        config.clientSecret = fileConfig.clientSecret;
      if (!config.redirectUri && fileConfig.redirectUri)
        config.redirectUri = fileConfig.redirectUri;
    } catch (error) {
      console.error(
        `Warning: Failed to parse Spotify configuration file ${CONFIG_FILE}. It might be corrupt.`
      );
      // Continuamos con lo que pudimos cargar de ENV
    }
  }

  // Validar que tenemos la configuración mínima necesaria
  if (!config.clientId || !config.clientSecret || !config.redirectUri) {
    throw new Error(
      `Spotify configuration missing.\nPlease set SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET, and SPOTIFY_REDIRECT_URI environment variables,\nOR create a ${path.basename(
        CONFIG_FILE
      )} file at the project root with these properties.\nExample ENV: export SPOTIFY_CLIENT_ID="YOUR_CLIENT_ID"\nExample File: {\n  "clientId": "YOUR_CLIENT_ID",\n  "clientSecret": "YOUR_CLIENT_SECRET",\n  "redirectUri": "http://127.0.0.1:4321/callback"\n}`
    );
  }

  return config;
}

/**
 * Guarda la configuración de Spotify. Solo guarda los tokens y la expiración
 * en el archivo para evitar escribir secretos (clientId, etc.) si vienen de ENV.
 */
export function saveSpotifyConfig(config: SpotifyConfig): void {
  const dataToSave: any = {};

  // Opcional: Leer el archivo existente para preservar clientId/Secret/Uri si vinieron de allí inicialmente
  // Esto es útil si el usuario NO usa ENV y empieza solo con el archivo.
  if (fs.existsSync(CONFIG_FILE)) {
    try {
      const existingConfig = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
      if (existingConfig.clientId)
        dataToSave.clientId = existingConfig.clientId;
      if (existingConfig.clientSecret)
        dataToSave.clientSecret = existingConfig.clientSecret;
      if (existingConfig.redirectUri)
        dataToSave.redirectUri = existingConfig.redirectUri;
    } catch (error) {
      console.error(
        `Warning: Could not read existing config file ${CONFIG_FILE} to preserve old settings.`
      );
      // Ignoramos el error y solo guardamos los tokens que tenemos.
    }
  }

  // Siempre guardar los tokens y expiración que tenemos en la config actual
  if (config.accessToken) dataToSave.accessToken = config.accessToken;
  if (config.refreshToken) dataToSave.refreshToken = config.refreshToken;
  if (config.expires_at) dataToSave.expires_at = config.expires_at;

  // Si no hay tokens ni expiración, no guardamos nada (ej: error inicial de auth)
  if (
    !dataToSave.accessToken &&
    !dataToSave.refreshToken &&
    !dataToSave.expires_at &&
    !dataToSave.clientId &&
    !dataToSave.clientSecret &&
    !dataToSave.redirectUri
  ) {
    console.error(
      "Attempted to save config, but no token or config data was present."
    );
    return; // No guardar un archivo vacío si solo hay un error
  }

  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(dataToSave, null, 2), "utf8");
    console.error(`Spotify configuration (tokens) saved to ${CONFIG_FILE}`); // Log a stderr
  } catch (error) {
    console.error(
      `Error saving Spotify configuration to ${CONFIG_FILE}: ${error}`
    ); // Log a stderr
    throw new Error(
      `Failed to save Spotify configuration: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

// --- El resto de las funciones permanecen en gran medida iguales ---
// Solo asegúrate de que llaman a las NUEVAS loadSpotifyConfig y saveSpotifyConfig

async function exchangeCodeForToken(
  code: string,
  config: SpotifyConfig // La config pasada ya viene de loadSpotifyConfig (ENV o File)
): Promise<{
  access_token: string;
  refresh_token: string;
  expires_in: number;
}> {
  const tokenUrl = `${SPOTIFY_ACCOUNTS_BASE}/api/token`;
  const authHeader = `Basic ${Buffer.from(
    `${config.clientId}:${config.clientSecret}` // Usar clientId y Secret de la config cargada
  ).toString("base64")}`;

  const params = new URLSearchParams();
  params.append("grant_type", "authorization_code");
  params.append("code", code);
  params.append("redirect_uri", config.redirectUri); // Usar redirectUri de la config cargada

  console.error("Attempting to exchange code for token...");

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
    );
    throw new Error(
      `Failed to exchange code for token: ${response.status} - ${errorData}`
    ); // Incluir más detalle en el error
  }

  const data = await response.json();
  if (typeof data.expires_in !== "number") {
    throw new Error("Token exchange response missing expires_in");
  }
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_in: data.expires_in,
  };
}

async function refreshToken(config: SpotifyConfig): Promise<SpotifyConfig> {
  // config pasada viene de loadSpotifyConfig
  if (!config.refreshToken) {
    throw new Error(
      "No refresh token available. Please set SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET, and SPOTIFY_REDIRECT_URI environment variables or create the config file, then run `npm run auth` again."
    );
  }

  const tokenUrl = `${SPOTIFY_ACCOUNTS_BASE}/api/token`;
  const authHeader = `Basic ${Buffer.from(
    `${config.clientId}:${config.clientSecret}` // Usar clientId y Secret de la config cargada
  ).toString("base64")}`;

  const params = new URLSearchParams();
  params.append("grant_type", "refresh_token");
  params.append("refresh_token", config.refreshToken);
  params.append("client_id", config.clientId); // Spotify recomienda incluir client_id aquí también

  console.error("Attempting to refresh Spotify token...");

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
    console.error(`Failed to refresh token: ${response.status} - ${errorData}`);
    if (response.status === 400 || response.status === 401) {
      throw new Error(
        `Spotify refresh token failed (${response.status}). This might mean your refresh token is invalid or expired. Please set SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET, and SPOTIFY_REDIRECT_URI environment variables or create/update the config file, then run \`npm run auth\` again.`
      );
    }
    throw new Error(
      `Failed to refresh token: ${response.status} - ${errorData}`
    ); // Incluir más detalle
  }

  const data = await response.json();

  if (typeof data.expires_in !== "number") {
    throw new Error("Token refresh response missing expires_in");
  }

  // Actualizar la config con el nuevo token y expiración
  config.accessToken = data.access_token;
  if (data.refresh_token) {
    config.refreshToken = data.refresh_token;
    console.error("Received a new refresh token from Spotify.");
  }
  config.expires_at = Date.now() + data.expires_in * 1000;

  // Guardar SOLO los tokens actualizados en el archivo
  saveSpotifyConfig(config); // Llama a la NUEVA saveSpotifyConfig

  console.error("Spotify token refreshed successfully.");
  return config; // Devolver la config actualizada
}

// Función genérica para manejar peticiones API con refresco
export async function handleSpotifyRequest<T>(
  method: string,
  path: string,
  queryParams?: Record<string, any>,
  body?: any,
  retryOnAuthError = true // Permitir reintentar una vez en caso de 401
): Promise<T | undefined> {
  let config = loadSpotifyConfig(); // Llama a la NUEVA loadSpotifyConfig

  if (!config.accessToken && !config.refreshToken) {
    // Si no hay ningún token, ni siquiera uno de refresco, requerimos auth
    throw new Error(
      "Spotify authentication required. No access or refresh token found. " +
        "Please set SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET, and SPOTIFY_REDIRECT_URI environment variables " +
        "or create the config file, then run `npm run auth` first."
    );
  }
  // Si no hay access token pero hay refresh token, intentamos refrescar inmediatamente
  if (!config.accessToken && config.refreshToken) {
    console.error(
      "No access token found, attempting to refresh using refresh token..."
    );
    try {
      config = await refreshToken(config); // config es actualizada y guardada dentro de refreshToken
    } catch (refreshError) {
      console.error("Initial refresh failed:", refreshError);
      throw refreshError; // Lanzar error si el refresh inicial falla
    }
    // Después de un refresh exitoso, ya tenemos un access token, procedemos
  }

  // 2. Verificar si el token de acceso ha expirado o está a punto de expirar
  if (
    config.accessToken && // Solo verificar si hay un access token
    config.expires_at &&
    config.expires_at < Date.now() + TOKEN_REFRESH_MARGIN
  ) {
    console.error(
      "Spotify token expired or near expiry, attempting refresh..."
    );
    try {
      // Intentar refrescar ANTES de la llamada
      config = await refreshToken(config); // config es actualizada y guardada dentro de refreshToken
    } catch (refreshError) {
      console.error("Initial token refresh failed:", refreshError);
      throw refreshError;
    }
  } else if (config.accessToken && config.expires_at) {
    const timeLeft = config.expires_at - Date.now();
    console.error(
      `Spotify access token valid for approx ${Math.max(
        0,
        Math.round(timeLeft / 1000)
      )} seconds.`
    );
  }

  // A este punto, deberíamos tener un access token válido (ya sea cargado o refrescado)
  if (!config.accessToken) {
    // Esto debería ser unreachable si la lógica anterior funciona, pero como fallback
    throw new Error(
      "Spotify access token missing after load and refresh attempt. Please re-authenticate."
    );
  }

  // 3. Preparar y hacer la llamada API usando el access token
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
    Authorization: `Bearer ${config.accessToken}`, // Usar el access token actual
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
    // Si obtenemos 401 y está permitido reintentar
    if (response.status === 401 && retryOnAuthError) {
      console.error(
        "Spotify API returned 401 Unauthorized. Attempting to refresh token and retry..."
      );
      try {
        // Refrescar y *guardar* la config actualizada
        const updatedConfig = await refreshToken(config); // config es actualizada y guardada dentro de refreshToken
        // Reintentar la llamada con el nuevo token, pero sin permitir otro reintento 401
        console.error("Retrying Spotify API request after token refresh...");
        return handleSpotifyRequest<T>(method, path, queryParams, body, false);
      } catch (refreshError) {
        console.error("Token refresh failed on retry after 401:", refreshError);
        throw new Error(
          "Spotify authentication expired or invalid refresh token. Please set SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET, and SPOTIFY_REDIRECT_URI environment variables or create/update the config file, then run `npm run auth` again."
        );
      }
    } else {
      // Manejar otros errores o 401 después de un reintento fallido
      let errorText = await response.text();
      try {
        const errorJson: SpotifyApiError = JSON.parse(errorText);
        errorText = errorJson.error?.message || errorText;
      } catch (e) {}
      throw new Error(`Spotify API Error (${response.status}): ${errorText}`);
    }
  }

  // Manejar respuestas exitosas
  if (response.status === 204) {
    return undefined;
  }

  if (response.status >= 200 && response.status < 300) {
    // Intentar parsear JSON si el status es 2xx
    try {
      // Algunos códigos 2xx (como 200 para PUT en algunos casos) pueden no tener cuerpo
      if (
        response.headers.get("content-length") === "0" ||
        (response.status === 200 && method === "PUT")
      ) {
        return undefined;
      }
      const responseData = await response.json();
      return responseData as T;
    } catch (error) {
      // Si falla el parseo JSON para un status 2xx que debería tener JSON
      console.error(
        `Failed to parse Spotify API response JSON for status ${response.status} ${method} ${path}:`,
        error
      );
      // Solo lanzar error si esperamos JSON (ej. GET, POST con cuerpo)
      if (method === "GET" || method === "POST" || body !== undefined) {
        throw new Error(
          `Failed to parse Spotify API response JSON for status ${response.status} ${method} ${path}`
        );
      }
      // Para otros casos (como PUT exitoso sin cuerpo), retornamos undefined
      return undefined;
    }
  }

  // Fallback para otros códigos no 2xx ni 401 manejados explícitamente
  console.error(
    `Spotify API returned unexpected status ${response.status} for ${method} ${path}.`
  );
  throw new Error(
    `Spotify API Error (Unexpected Status ${response.status}): ${method} ${path}`
  );
}

export async function authorizeSpotify(): Promise<void> {
  const config = loadSpotifyConfig(); // Llama a la NUEVA loadSpotifyConfig (usará ENV o file para los iniciales)

  const redirectUri = new URL(config.redirectUri);
  const port = redirectUri.port || "4321";
  // Asegurarse de que el hostname es localhost o 127.0.0.1 para el callback HTTP
  if (
    redirectUri.hostname !== "localhost" &&
    redirectUri.hostname !== "127.0.0.1"
  ) {
    // No lanzar error, solo advertir. Algunos servicios proxy pueden usar otros hostnames.
    console.warn(
      `Warning: Redirect URI hostname is "${redirectUri.hostname}". Automatic token exchange via HTTP server requires localhost or 127.0.0.1.`
    );
    console.warn("You might need to handle the callback URL manually.");
  }
  const callbackPath = redirectUri.pathname || "/callback";

  const state = generateRandomString(16);

  // Define los scopes que necesitas
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
    // Agrega o quita scopes según las necesidades de tu aplicación
  ];

  const authParams = new URLSearchParams({
    client_id: config.clientId, // Usar clientId de la config cargada
    response_type: "code",
    redirect_uri: config.redirectUri, // Usar redirectUri de la config cargada
    scope: scopes.join(" "),
    state: state,
    show_dialog: "true", // Forzar la pantalla de login/permisos cada vez (útil durante desarrollo)
  });

  const authorizationUrl = `${SPOTIFY_ACCOUNTS_BASE}/authorize?${authParams.toString()}`;

  const authPromise = new Promise<void>((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      if (!req.url) {
        res.writeHead(400).end("No URL provided");
        server.close(() => reject(new Error("Request had no URL")));
        return;
      }

      // Asegurarse de usar el hostname y puerto correctos del redirectUri para parsear la URL de la solicitud
      // Aunque la solicitud al servidor http siempre será a localhost/127.0.0.1, la URL completa en req.url
      // no incluye el hostname/port, por eso construimos una URL base ficticia para parsear.
      const reqUrl = new URL(req.url, `http://127.0.0.1:${port}`);

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
          server.close(() =>
            reject(
              new Error(
                `Spotify authorization failed: ${error}. Check application logs for details.`
              )
            )
          );
          return;
        }

        if (returnedState !== state) {
          console.error("State mismatch error");
          res.end(
            "<html><body><h1>Authentication Failed</h1><p>State verification failed. Please close this window and try again.</p></body></html>"
          );
          server.close(() =>
            reject(new Error("Spotify authorization failed: State mismatch."))
          );
          return;
        }

        if (!code) {
          console.error("No authorization code received");
          res.end(
            "<html><body><h1>Authentication Failed</h1><p>No authorization code received. Please close this window and try again.</p></body></html>"
          );
          server.close(() =>
            reject(
              new Error(
                "Spotify authorization failed: No authorization code received."
              )
            )
          );
          return;
        }

        try {
          // Cargar la configuración actual (contiene clientId/Secret/Uri, posiblemente de ENV o archivo)
          const currentConfig = loadSpotifyConfig();
          // Intercambiar código por tokens
          const tokens = await exchangeCodeForToken(code, currentConfig);
          // Actualizar la configuración con los nuevos tokens y expiración
          currentConfig.accessToken = tokens.access_token;
          currentConfig.refreshToken = tokens.refresh_token;
          currentConfig.expires_at = Date.now() + tokens.expires_in * 1000;

          // Guardar SOLO los tokens y expiración en el archivo
          saveSpotifyConfig(currentConfig); // Llama a la NUEVA saveSpotifyConfig

          res.end(
            "<html><body><h1>Authentication Successful!</h1><p>You can now close this window and return to the application.</p></body></html>"
          );
          console.error("Authentication successful! Tokens saved.");

          server.close(() => resolve());
        } catch (exchangeError) {
          console.error("Token exchange error:", exchangeError);
          res.end(
            "<html><body><h1>Authentication Failed</h1><p>Failed to exchange authorization code for tokens. Please check logs and try again.</p></body></html>"
          );
          server.close(() => reject(exchangeError));
        }
      } else {
        res.writeHead(404).end(); // Manejar rutas que no son el callback
      }
    });

    // Intentar escuchar en el puerto del redirectUri
    server.listen(Number.parseInt(port, 10), "127.0.0.1", () => {
      console.error(
        `Listening for Spotify callback on http://127.0.0.1:${port}${callbackPath}`
      );
      console.error("Opening browser for authorization...");
      open(authorizationUrl).catch((openError: Error) => {
        console.error(
          "Failed to open browser automatically. Please visit this URL manually to authorize:"
        );
        console.error(authorizationUrl);
      });
    });

    server.on("error", (serverError: any) => {
      if (serverError.code === "EADDRINUSE") {
        console.error(`Error: Port ${port} is already in use.`);
        console.error(
          "Please ensure no other process is using this port, or configure a different redirectUri port."
        );
        reject(
          new Error(
            `Spotify authorization failed: Port ${port} is already in use.`
          )
        );
      } else {
        console.error(
          `HTTP server error during auth flow: ${serverError.message}`
        );
        reject(serverError);
      }
    });
  });

  await authPromise;
}

// Helper para generar strings aleatorios (sin cambios)
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

// Helper para formatear duración (sin cambios)
export function formatDuration(ms: number): string {
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.round((ms % 60000) / 1000);
  if (seconds === 60) {
    return `${minutes + 1}:00`;
  }
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}
