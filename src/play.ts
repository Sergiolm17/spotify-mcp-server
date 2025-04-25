// src/play.ts
import { handleSpotifyRequest } from "./utils.js";

import { z } from "zod";
import type { tool, SpotifyUserProfile, SpotifyPlaylist } from "./types.js"; // Importar tipos necesarios

// Nota sobre tool<Args>: El segundo argumento 'extra' del handler
// es el contexto de la petición MCP. No se usa en estos manejadores,
// pero se mantiene en el tipo 'tool' por si se necesita logging, etc.

const playMusic: tool<{
  uri: z.ZodOptional<z.ZodString>; // URI completo de Spotify (spotify:...)
  type: z.ZodOptional<z.ZodEnum<["track", "album", "artist", "playlist"]>>; // Tipo del item
  id: z.ZodOptional<z.ZodString>; // ID del item
  deviceId: z.ZodOptional<z.ZodNullable<z.ZodString>>; // ID del dispositivo
}> = {
  name: "playMusic",
  description:
    "Start playing a Spotify track, album, artist, or playlist. Requires a Spotify URI (spotify:track:...) or both type (track, album, artist, playlist) and id.",
  schema: {
    uri: z
      .string()
      .optional()
      .describe(
        "The Spotify URI to play (overrides type and id), e.g., spotify:track:11dFghVXANMlKmJXsNCbNl"
      ),
    type: z
      .enum(["track", "album", "artist", "playlist"])
      .optional()
      .describe("The type of item to play (only used if uri is not provided)"),
    id: z
      .string()
      .optional()
      .describe(
        "The Spotify ID of the item to play (only used if uri is not provided)"
      ),
    deviceId: z
      .string()
      .nullable()
      .optional()
      .describe(
        "The Spotify device ID to play on. If not provided, plays on the active device."
      ),
  },
  handler: async (
    args,
    extra // Mantener extra por si se necesita
  ) => {
    const { uri, type, id, deviceId } = args;

    let spotifyUri = uri;
    if (!spotifyUri && type && id) {
      spotifyUri = `spotify:${type}:${id}`;
    }

    // Validar que tenemos algo para reproducir
    if (!spotifyUri) {
      // Si no se pudo formar un URI y tampoco se proporcionó un deviceId
      // para intentar reanudar (caso de startResumePlayback sin URI),
      // consideramos que hay un error en los argumentos.
      // La herramienta startResumePlayback sin URI se maneja abajo si spotifyUri es undefined.
      if (deviceId === undefined) {
        // Asumiendo que startResumePlayback con deviceId="" reanuda el activo
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: "Error: Must provide a Spotify URI (spotify:...) or both type and id. If trying to resume, provide deviceId.",
            },
          ],
        };
      }
      // Si se proporcionó deviceId pero no URI/type/id, intentaremos reanudar
    }

    try {
      // La API de Spotify para start/resume playback usa PUT /v1/me/player/play
      // Con body { "uris": ["spotify:track:id"] } para tracks
      // Con body { "context_uri": "spotify:type:id" } para álbum/artista/playlist
      // Sin body para reanudar la reproducción actual en el dispositivo especificado (o activo)

      const path = "/v1/me/player/play";
      const query: { device_id?: string } = {}; // Usar snake_case para query params
      const body: { uris?: string[]; context_uri?: string } = {}; // Usar snake_case para body keys

      if (deviceId) {
        query.device_id = deviceId;
      }

      if (spotifyUri) {
        if (type === "track" || !type) {
          // Si es track o no se especifica tipo (asumimos track si es URI)
          // Validar formato URI si no se especificó tipo
          if (!type && !spotifyUri.startsWith("spotify:track:")) {
            return {
              isError: true,
              content: [
                {
                  type: "text",
                  text: `Error: Invalid Spotify Track URI format provided: ${spotifyUri}. Must start with 'spotify:track:'.`,
                },
              ],
            };
          }
          body.uris = [spotifyUri];
        } else {
          // album, artist, playlist (o si se especifica tipo aunque sea track)
          // Validar formato URI si se especificó tipo
          if (!spotifyUri.startsWith(`spotify:${type}:`)) {
            return {
              isError: true,
              content: [
                {
                  type: "text",
                  text: `Error: Invalid Spotify URI format for type '${type}': ${spotifyUri}. Must start with 'spotify:${type}:'.`,
                },
              ],
            };
          }
          body.context_uri = spotifyUri;
        }
      } else {
        // Si no hay spotifyUri, significa que solo se proporcionó deviceId,
        // lo que implica reanudar la reproducción actual. No hay body.
        // La query ya tiene device_id si se proporcionó.
        console.error(
          "playMusic called without URI/type/id, attempting to resume playback on device:",
          deviceId || "active"
        ); // Log a stderr
      }

      // Llamar a la API usando la función genérica
      // PUT requests with body usually return 204 No Content on success
      const result = await handleSpotifyRequest<undefined>(
        "PUT",
        path,
        query,
        Object.keys(body).length > 0 ? body : undefined
      ); // Pasar body solo si no está vacío

      let successMessage = `Playback started.`;
      if (spotifyUri) {
        successMessage = `Started playing ${spotifyUri}${
          deviceId ? ` on device ${deviceId}` : ""
        }.`;
      } else if (deviceId) {
        successMessage = `Attempted to resume playback on device ${deviceId}.`;
      } else {
        successMessage = `Attempted to resume playback on the active device.`;
      }

      return {
        content: [
          {
            type: "text",
            text: successMessage,
          },
        ],
      };
    } catch (error) {
      // Capturar errores de la API o de handleSpotifyRequest
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `Error playing music: ${
              error instanceof Error ? error.message : String(error)
            }`,
          },
        ],
      };
    }
  },
};

const pausePlayback: tool<{
  deviceId: z.ZodOptional<z.ZodNullable<z.ZodString>>;
}> = {
  name: "pausePlayback",
  description:
    "Pause Spotify playback on the active device. Optionally specify a device ID.",
  schema: {
    deviceId: z
      .string()
      .nullable()
      .optional()
      .describe(
        "The Spotify device ID to pause playback on. If not provided, pauses on the active device."
      ),
  },
  handler: async (
    args,
    extra // Mantener extra
  ) => {
    const { deviceId } = args;
    const query: { device_id?: string } = {}; // Usar snake_case
    if (deviceId) {
      query.device_id = deviceId;
    }

    try {
      // PUT /v1/me/player/pause
      await handleSpotifyRequest<undefined>(
        "PUT",
        "/v1/me/player/pause",
        query
      ); // Espera 204 No Content

      return {
        content: [
          {
            type: "text",
            text: `Playback paused${deviceId ? ` on device ${deviceId}` : ""}.`,
          },
        ],
      };
    } catch (error) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `Error pausing playback: ${
              error instanceof Error ? error.message : String(error)
            }`,
          },
        ],
      };
    }
  },
};

const skipToNext: tool<{
  deviceId: z.ZodOptional<z.ZodNullable<z.ZodString>>;
}> = {
  name: "skipToNext",
  description:
    "Skip to the next track in the current Spotify playback queue. Optionally specify a device ID.",
  schema: {
    deviceId: z
      .string()
      .nullable()
      .optional()
      .describe(
        "The Spotify device ID to skip on. If not provided, skips on the active device."
      ),
  },
  handler: async (
    args,
    extra // Mantener extra
  ) => {
    const { deviceId } = args;
    const query: { device_id?: string } = {}; // Usar snake_case
    if (deviceId) {
      query.device_id = deviceId;
    }

    try {
      // POST /v1/me/player/next
      await handleSpotifyRequest<undefined>(
        "POST",
        "/v1/me/player/next",
        query
      ); // Espera 204 No Content

      return {
        content: [
          {
            type: "text",
            text: `Skipped to next track${
              deviceId ? ` on device ${deviceId}` : ""
            }.`,
          },
        ],
      };
    } catch (error) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `Error skipping to next track: ${
              error instanceof Error ? error.message : String(error)
            }`,
          },
        ],
      };
    }
  },
};

const skipToPrevious: tool<{
  deviceId: z.ZodOptional<z.ZodNullable<z.ZodString>>;
}> = {
  name: "skipToPrevious",
  description:
    "Skip to the previous track in the current Spotify playback queue. Optionally specify a device ID.",
  schema: {
    deviceId: z
      .string()
      .nullable()
      .optional()
      .describe(
        "The Spotify device ID to skip on. If not provided, skips on the active device."
      ),
  },
  handler: async (
    args,
    extra // Mantener extra
  ) => {
    const { deviceId } = args;
    const query: { device_id?: string } = {}; // Usar snake_case
    if (deviceId) {
      query.device_id = deviceId;
    }

    try {
      // POST /v1/me/player/previous
      await handleSpotifyRequest<undefined>(
        "POST",
        "/v1/me/player/previous",
        query
      ); // Espera 204 No Content

      return {
        content: [
          {
            type: "text",
            text: `Skipped to previous track${
              deviceId ? ` on device ${deviceId}` : ""
            }.`,
          },
        ],
      };
    } catch (error) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `Error skipping to previous track: ${
              error instanceof Error ? error.message : String(error)
            }`,
          },
        ],
      };
    }
  },
};

const createPlaylist: tool<{
  name: z.ZodString;
  description: z.ZodOptional<z.ZodString>;
  public: z.ZodOptional<z.ZodBoolean>;
}> = {
  name: "createPlaylist",
  description: "Create a new playlist on Spotify for the current user.",
  schema: {
    name: z.string().describe("The name for the new playlist."),
    description: z
      .string()
      .optional()
      .describe("The description for the new playlist."),
    public: z
      .boolean()
      .optional()
      .describe(
        "If true, the playlist will be public; if false, it will be private."
      ),
  },
  handler: async (
    args,
    extra // Mantener extra
  ) => {
    const { name, description, public: isPublic = false } = args;

    try {
      // Primero, obtener el ID del usuario actual
      // GET /v1/me
      const userProfile = await handleSpotifyRequest<SpotifyUserProfile>(
        "GET",
        "/v1/me"
      );

      if (!userProfile?.id) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: "Error: Could not retrieve current user ID.",
            },
          ],
        };
      }

      // Luego, crear la playlist para ese usuario
      // POST /v1/users/{user_id}/playlists
      const path = `/v1/users/${userProfile.id}/playlists`;
      const body = {
        // Usar snake_case
        name: name,
        description: description,
        public: isPublic,
        collaborative: false, // Asumimos que no es colaborativa por defecto
      };

      const result = await handleSpotifyRequest<SpotifyPlaylist>(
        "POST",
        path,
        undefined,
        body
      );

      if (!result?.id) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: "Error: Spotify API did not return a playlist ID after creation.",
            },
          ],
        };
      }

      return {
        content: [
          {
            type: "text",
            text: `Successfully created playlist "${name}" (ID: ${result.id}).`,
          },
        ],
      };
    } catch (error) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `Error creating playlist: ${
              error instanceof Error ? error.message : String(error)
            }`,
          },
        ],
      };
    }
  },
};

const updatePlaylistItems: tool<{
  playlistId: z.ZodString;
  // Usamos z.union o estructura opcional para manejar las dos operaciones mutuamente excluyentes
  // Opción 1: Reemplazar items
  replace: z.ZodOptional<
    z.ZodObject<{
      uris: z.ZodArray<z.ZodString>; // Array de URIs de tracks/episodios
    }>
  >;
  // Opción 2: Reordenar items
  reorder: z.ZodOptional<
    z.ZodObject<{
      rangeStart: z.ZodNumber; // Posición inicial a reordenar (0-based)
      insertBefore: z.ZodNumber; // Posición donde insertar los items (0-based)
      rangeLength: z.ZodOptional<z.ZodNumber>; // Cantidad de items a reordenar desde rangeStart (default 1)
      snapshotId: z.ZodString; // Snapshot ID de la playlist, requerido para reordenar
    }>
  >;
}> = {
  name: "updatePlaylistItems",
  description:
    "Update items in a Spotify playlist. Can either REORDER items or REPLACE ALL existing items. Provide EITHER 'replace' parameters OR 'reorder' parameters, but not both. Returns the new playlist snapshot ID on success.",
  schema: {
    playlistId: z.string().describe("The Spotify ID of the playlist."),
    // Define los parámetros para la operación de 'reemplazar'
    replace: z
      .object({
        uris: z
          .array(z.string())
          .min(1, "Must provide at least one URI for replacement.")
          .max(100, "Cannot replace more than 100 items at once.")
          .describe(
            "Array of Spotify track or episode URIs (e.g., spotify:track:...) to replace *all* existing items in the playlist. Max 100 URIs."
          ),
      })
      .optional()
      .describe("Parameters for replacing ALL items in the playlist."), // Descripción para el LLM
    // Define los parámetros para la operación de 'reordenar'
    reorder: z
      .object({
        rangeStart: z
          .number()
          .int()
          .nonnegative()
          .describe(
            "The position (0-based index) of the first item to reorder."
          ),
        insertBefore: z
          .number()
          .int()
          .nonnegative()
          .describe(
            "The position (0-based index) where the selected items should be inserted."
          ),
        rangeLength: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe(
            "The number of items to reorder, starting from rangeStart. Defaults to 1."
          ),
        snapshotId: z
          .string()
          .describe(
            "The playlist's snapshot ID, required to perform the reorder operation."
          ),
      })
      .optional()
      .describe(
        "Parameters for reordering items within the playlist. Provide rangeStart, insertBefore, and snapshotId."
      ), // Descripción para el LLM
  },
  handler: async (args) => {
    const { playlistId, replace, reorder } = args;

    // Validar que exactamente una de las operaciones fue especificada
    if ((replace && reorder) || (!replace && !reorder)) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: "Error: Must provide EITHER 'replace' parameters OR 'reorder' parameters, but not both.",
          },
        ],
      };
    }

    try {
      const path = `/v1/playlists/${playlistId}/tracks`;
      let body: any; // El body varía según la operación
      let successMessage = "";

      if (replace) {
        // Operación de REEMPLAZAR
        if (!replace.uris || replace.uris.length === 0) {
          // Aunque la schema Zod ya lo valida (min(1)), una doble verificación no hace daño
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: "Error: 'replace' operation requires a non-empty array of 'uris'.",
              },
            ],
          };
        }
        if (replace.uris.length > 100) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: `Error: Cannot replace more than 100 items at once. You provided ${replace.uris.length}.`,
              },
            ],
          };
        }
        body = { uris: replace.uris }; // Formato esperado por la API
        successMessage = `Successfully replaced all items in playlist (ID: ${playlistId}) with ${replace.uris.length} item(s).`;
      } else if (reorder) {
        // Operación de REORDENAR
        if (
          reorder.rangeStart === undefined ||
          reorder.insertBefore === undefined ||
          !reorder.snapshotId
        ) {
          // Aunque la schema Zod lo valida, doble verificación
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: "Error: 'reorder' operation requires 'rangeStart', 'insertBefore', and 'snapshotId'.",
              },
            ],
          };
        }
        body = {
          range_start: reorder.rangeStart,
          insert_before: reorder.insertBefore,
          range_length: reorder.rangeLength ?? 1, // Usar default 1 si no se proporciona
          snapshot_id: reorder.snapshotId,
        }; // Formato esperado por la API (snake_case)
        successMessage = `Successfully reordered item(s) in playlist (ID: ${playlistId}).`;
      }

      // La API PUT /v1/playlists/{playlist_id}/tracks devuelve un objeto con el nuevo snapshot_id
      const result = await handleSpotifyRequest<{ snapshot_id: string }>(
        "PUT",
        path,
        undefined, // No hay query params para esta operación PUT
        body
      );

      if (!result?.snapshot_id) {
        // Aunque la API debería devolverlo, lo verificamos
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: "Error: Spotify API did not return a new snapshot ID after the update.",
            },
          ],
        };
      }

      // Retornar el resultado exitoso con el nuevo snapshot_id
      return {
        content: [
          {
            type: "text",
            text: `${successMessage}\nNew Playlist Snapshot ID: ${result.snapshot_id}`,
          },
        ],
      };
    } catch (error) {
      // Capturar errores de la API o de handleSpotifyRequest
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `Error updating playlist items (ID: ${playlistId}): ${
              error instanceof Error ? error.message : String(error)
            }`,
          },
        ],
      };
    }
  },
};

const addTracksToPlaylist: tool<{
  playlistId: z.ZodString;
  trackIds: z.ZodArray<z.ZodString>;
  position: z.ZodOptional<z.ZodNumber>;
}> = {
  name: "addTracksToPlaylist",
  description:
    "Add tracks to a Spotify playlist. Provide the playlist ID and an array of track IDs.",
  schema: {
    playlistId: z
      .string()
      .describe("The Spotify ID of the playlist to add tracks to."),
    trackIds: z
      .array(z.string())
      .describe("An array of Spotify track IDs to add to the playlist."),
    position: z
      .number()
      .nonnegative()
      .optional()
      .describe(
        "The position (0-based index) to insert the tracks in the playlist."
      ),
  },
  handler: async (
    args,
    extra // Mantener extra
  ) => {
    const { playlistId, trackIds, position } = args;

    if (trackIds.length === 0) {
      return {
        isError: true, // Es un error de argumentos
        content: [
          {
            type: "text",
            text: "Error: No track IDs provided.",
          },
        ],
      };
    }
    if (trackIds.length > 100) {
      // La API tiene un límite, según docs es 100 para addItemsToPlaylist
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `Error: Cannot add more than 100 tracks at once. You provided ${trackIds.length}.`,
          },
        ],
      };
    }

    try {
      const trackUris = trackIds.map((id) => `spotify:track:${id}`);

      // POST /v1/playlists/{playlist_id}/tracks
      const path = `/v1/playlists/${playlistId}/tracks`;
      const query: { position?: number } = {};
      if (position !== undefined) {
        query.position = position;
      }
      const body = {
        // Usar snake_case
        uris: trackUris,
      };

      await handleSpotifyRequest<undefined>("POST", path, query, body); // Espera 201 Created o 200 OK, pero el SDK de Spotify a veces no devuelve body aquí

      return {
        content: [
          {
            type: "text",
            text: `Successfully added ${trackIds.length} track${
              trackIds.length === 1 ? "" : "s"
            } to playlist (ID: ${playlistId}).`,
          },
        ],
      };
    } catch (error) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `Error adding tracks to playlist (ID: ${playlistId}): ${
              error instanceof Error ? error.message : String(error)
            }`,
          },
        ],
      };
    }
  },
};

const resumePlayback: tool<{
  deviceId: z.ZodOptional<z.ZodNullable<z.ZodString>>;
}> = {
  name: "resumePlayback",
  description:
    "Resume Spotify playback on the active device. Optionally specify a device ID.",
  schema: {
    deviceId: z
      .string()
      .nullable()
      .optional()
      .describe(
        "The Spotify device ID to resume playback on. If not provided, resumes on the active device."
      ),
  },
  handler: async (
    args,
    extra // Mantener extra
  ) => {
    const { deviceId } = args;
    const query: { device_id?: string } = {}; // Usar snake_case
    if (deviceId) {
      query.device_id = deviceId;
    }

    try {
      // PUT /v1/me/player/play (sin body)
      await handleSpotifyRequest<undefined>("PUT", "/v1/me/player/play", query); // Espera 204 No Content

      return {
        content: [
          {
            type: "text",
            text: `Playback resumed${
              deviceId ? ` on device ${deviceId}` : ""
            }.`,
          },
        ],
      };
    } catch (error) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `Error resuming playback: ${
              error instanceof Error ? error.message : String(error)
            }`,
          },
        ],
      };
    }
  },
};

const addToQueue: tool<{
  uri: z.ZodOptional<z.ZodString>;
  type: z.ZodOptional<z.ZodEnum<["track", "album", "artist", "playlist"]>>; // Aunque la API oficial solo soporta tracks, la schema original lo permite
  id: z.ZodOptional<z.ZodString>;
  deviceId: z.ZodOptional<z.ZodNullable<z.ZodString>>;
}> = {
  name: "addToQueue",
  description:
    "Adds a track to the playback queue. Requires a Spotify URI (spotify:track:...). Optionally specify a device ID.",
  schema: {
    uri: z
      .string()
      .optional()
      .describe(
        "The Spotify URI of the track to add to the queue, e.g., spotify:track:11dFghVXANMlKmJXsNCbNl. (Overrides type and id)."
      ),
    // Los campos type e id se mantienen en la schema Zod para compatibilidad con la definición original,
    // pero la API oficial de Spotify solo soporta URIs de tracks para la cola.
    type: z
      .enum(["track", "album", "artist", "playlist"]) // La API solo soporta 'track' URIs aquí
      .optional()
      .describe(
        "The type of item to add (only 'track' is supported by Spotify API for queue)."
      ),
    id: z
      .string()
      .optional()
      .describe(
        "The Spotify ID of the item (only used if uri is not provided, and only for type 'track')."
      ),
    deviceId: z
      .string()
      .nullable()
      .optional()
      .describe(
        "The Spotify device ID to add the item to the queue on. If not provided, uses the active device."
      ),
  },
  handler: async (args) => {
    const { uri, type, id, deviceId } = args;

    let spotifyUri = uri;
    // Si no se proporciona URI, intentar construirlo.
    // Advertir si el tipo no es 'track', ya que la API oficial no lo soporta para la cola.
    if (!spotifyUri && type && id) {
      if (type !== "track") {
        console.error(
          `Warning: Spotify API /queue endpoint only supports track URIs. You provided type: ${type}. Attempting with URI spotify:${type}:${id} anyway.`
        ); // Log a stderr
      }
      spotifyUri = `spotify:${type}:${id}`;
    } else if (!spotifyUri && type !== "track" && id) {
      // Si se proporcionó type e id pero NO uri, y el tipo no es track,
      // lanzar un error claro porque la API no lo soporta.
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `Error: Spotify API /queue endpoint only supports track URIs. You provided type: ${type}.`,
          },
        ],
      };
    }

    if (!spotifyUri) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: "Error: Must provide a Spotify URI (spotify:...) or both type and id (for type 'track').",
          },
        ],
      };
    }
    // Validar que el URI formado/proporcionado es un track URI si el tipo fue 'track' o no se especificó
    if (
      (!type || type === "track") &&
      !spotifyUri.startsWith("spotify:track:")
    ) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `Error: Invalid Spotify Track URI format provided: ${spotifyUri}. Must start with 'spotify:track:'.`,
          },
        ],
      };
    }

    try {
      // POST /v1/me/player/queue
      const path = "/v1/me/player/queue";
      const query: { uri: string; device_id?: string } = {
        // Usar snake_case
        uri: spotifyUri,
      };
      if (deviceId) {
        query.device_id = deviceId;
      }

      // POST requests to /queue usually return 204 No Content on success
      await handleSpotifyRequest<undefined>("POST", path, query); // Espera 204 No Content

      return {
        content: [
          {
            type: "text",
            text: `Added item ${spotifyUri} to queue.`,
          },
        ],
      };
    } catch (error) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `Error adding item to queue: ${
              error instanceof Error ? error.message : String(error)
            }`,
          },
        ],
      };
    }
  },
};

export const playTools = [
  playMusic,
  pausePlayback,
  skipToNext,
  skipToPrevious,
  createPlaylist,
  updatePlaylistItems,
  addTracksToPlaylist,
  resumePlayback,
  addToQueue,
];
