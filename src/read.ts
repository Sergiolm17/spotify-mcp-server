import { z } from "zod";
import type {
  SpotifyTrack,
  tool,
  SpotifySearchResults,
  SpotifyCurrentlyPlaying,
  SpotifyUserPlaylists,
  SpotifyPlaylistItems,
  SpotifyRecentlyPlayed,
} from "./types.js";
import { formatDuration, handleSpotifyRequest } from "./utils.js";

// Función de ayuda para verificar si un item es un track de Spotify
function isTrack(item: any): item is SpotifyTrack {
  return (
    item !== null && // Asegurar que no es null
    typeof item === "object" && // Asegurar que es un objeto
    item.type === "track" &&
    typeof item.name === "string" &&
    Array.isArray(item.artists) &&
    item.album !== null &&
    typeof item.album === "object" && // Asegurar que album no es null y es objeto
    typeof item.album.name === "string" &&
    typeof item.id === "string"
  );
}

// Añadir una interfaz básica para otros tipos de items que no son tracks (ej: Episode)
interface BasicSpotifyItem {
  id?: string;
  type?: string;
  name?: string;
  duration_ms?: number; // Episodios también tienen duración
  // Añadir otras propiedades comunes si se necesitan
}

const searchSpotify: tool<{
  query: z.ZodString;
  type: z.ZodEnum<["album", "artist", "playlist", "track", "show", "episode"]>;
  limit: z.ZodOptional<z.ZodNumber>;
}> = {
  name: "searchSpotify",
  description:
    "Search for tracks, albums, artists, or playlists on Spotify. Returns basic info and Spotify ID.",
  schema: {
    query: z.string().describe("The search query string."),
    type: z
      .enum(["album", "artist", "playlist", "track", "show", "episode"])
      .describe(
        "The type of item to search for: 'album', 'artist', 'playlist', 'track', 'show', 'episode']."
      ),
    limit: z
      .number()
      .min(1)
      .max(50) // La API oficial permite hasta 50 para search
      .optional()
      .describe("Maximum number of results to return (1-50). Defaults to 10."),
  },
  handler: async (args) => {
    const { query, type, limit } = args;
    const limitValue = limit ?? 10;

    try {
      const path = "/v1/search";
      const queryParams = {
        q: query,
        type: type,
        limit: limitValue,
      };

      const results = await handleSpotifyRequest<SpotifySearchResults>(
        "GET",
        path,
        queryParams
      );

      let formattedResults = "";
      if (type === "show" && results?.shows?.items) {
        formattedResults = results.shows.items
          .map((show, i) => {
            // Formatear show: Nombre, Descripción, ID
            return `${i + 1}. "${show.name || "Unknown Show"}" - ${
              show.description || "No description"
            } - ID: ${show.id}`;
          })
          .join("\n");
      } else if (type === "episode" && results?.episodes?.items) {
        formattedResults = results.episodes.items
          .map((episode, i) => {
            // Formatear episode: Nombre, Duración, Fecha de lanzamiento (opcional), ID
            const duration = formatDuration(episode.duration_ms);
            // Puedes añadir la fecha de lanzamiento si la necesitas y la añades a la interfaz SimplifiedEpisodeObject
            // const releaseDate = episode.release_date || "Unknown Date";
            return `${i + 1}. "${
              episode.name || "Unknown Episode"
            }" (${duration}) - ${
              episode.description || "No description"
            } - ID: ${episode.id}`;
          })
          .join("\n");
      } else if (type === "track" && results?.tracks?.items) {
        formattedResults = results.tracks.items
          .map((track, i) => {
            const artists =
              track.artists?.map((a) => a.name).join(", ") ||
              "Unknown Artist(s)";
            const duration = formatDuration(track.duration_ms);
            return `${i + 1}. "${
              track.name || "Unknown Track"
            }" by ${artists} (${duration}) - ID: ${track.id}`;
          })
          .join("\n");
      } else if (type === "album" && results?.albums?.items) {
        formattedResults = results.albums.items
          .map((album, i) => {
            const artists =
              album.artists?.map((a) => a.name).join(", ") ||
              "Unknown Artist(s)";
            return `${i + 1}. "${
              album.name || "Unknown Album"
            }" by ${artists} - ID: ${album.id}`;
          })
          .join("\n");
      } else if (type === "artist" && results?.artists?.items) {
        formattedResults = results.artists.items
          .map((artist, i) => {
            return `${i + 1}. ${artist.name || "Unknown Artist"} - ID: ${
              artist.id
            }`;
          })
          .join("\n");
      } else if (type === "playlist" && results?.playlists?.items) {
        formattedResults = results.playlists.items
          .map((playlist, i) => {
            return `${i + 1}. "${playlist?.name ?? "Unknown Playlist"}" (${
              playlist?.tracks?.total
                ? `${playlist.tracks.total} tracks`
                : "Unknown tracks"
            }) by ${playlist?.owner?.display_name ?? "Unknown Owner"} - ID: ${
              playlist?.id
            }`;
          })
          .join("\n");
      } else {
        // Si no hay items para el tipo, o la estructura es inesperada
        return {
          content: [
            { type: "text", text: `No ${type} results found for "${query}".` },
          ],
        };
      }

      return {
        content: [
          {
            type: "text",
            text:
              formattedResults.length > 0
                ? `# Search results for "${query}" (type: ${type}, limit: ${limitValue})\n\n${formattedResults}`
                : `No ${type} results found for "${query}".`,
          },
        ],
      };
    } catch (error) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `Error searching for ${type}s: ${
              error instanceof Error ? error.message : String(error)
            }`,
          },
        ],
      };
    }
  },
};

const getNowPlaying: tool<Record<string, never>> = {
  name: "getNowPlaying",
  description:
    "Get information about the currently playing track or item on Spotify.",
  schema: {},
  handler: async (args) => {
    try {
      const currentItem = await handleSpotifyRequest<SpotifyCurrentlyPlaying>(
        "GET",
        "/v1/me/player/currently-playing"
      );

      // Si no hay nada reproduciéndose o la respuesta es inesperada (null/undefined)
      if (
        currentItem === undefined ||
        currentItem === null ||
        !currentItem.item
      ) {
        return {
          content: [
            {
              type: "text",
              text: "Nothing is currently playing on Spotify.",
            },
          ],
        };
      }

      const item = currentItem.item;
      const isPlaying = currentItem.is_playing;
      const progress = currentItem.progress_ms || 0;

      let formattedResult = `# Currently ${
        isPlaying ? "Playing" : "Paused"
      }\n\n`;

      // Comprobar si el item es un Track usando la función isTrack
      if (isTrack(item)) {
        const artists =
          item.artists.map((a) => a.name).join(", ") || "Unknown Artist(s)";
        const album = item.album?.name || "Unknown Album";
        const duration = formatDuration(item.duration_ms);
        const formattedProgress = formatDuration(progress);

        formattedResult +=
          `**Track**: "${item.name}"\n` +
          `**Artist**: ${artists}\n` +
          `**Album**: ${album}\n` +
          `**Progress**: ${formattedProgress} / ${duration}\n` +
          `**ID**: ${item.id}`;
      } else {
        // Si el item no es un Track, tratarlo como un item básico y acceder con seguridad
        const basicItem = item as BasicSpotifyItem | null; // Castear a la nueva interfaz básica, permitiendo null

        formattedResult += `Item Type: ${basicItem?.type || "Unknown"}\n`;
        if (basicItem?.name) formattedResult += `Name: "${basicItem.name}"\n`;
        if (basicItem?.id) formattedResult += `ID: ${basicItem.id}\n`;

        const duration =
          basicItem?.duration_ms !== undefined && basicItem.duration_ms !== null
            ? formatDuration(basicItem.duration_ms)
            : "Unknown Duration";

        formattedResult += `Progress: ${formatDuration(
          progress
        )} / ${duration}`;
        formattedResult += `\nNote: Currently playing item is not a standard track. It might be a podcast episode, ad, etc.`;
      }

      return {
        content: [
          {
            type: "text",
            text: formattedResult,
          },
        ],
      };
    } catch (error) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `Error getting current item: ${
              error instanceof Error ? error.message : String(error)
            }`,
          },
        ],
      };
    }
  },
};

const getMyPlaylists: tool<{
  limit: z.ZodOptional<z.ZodNumber>;
}> = {
  name: "getMyPlaylists",
  description:
    "Get a list of the current user's playlists on Spotify. Returns name, total tracks, and Spotify ID.",
  schema: {
    limit: z
      .number()
      .min(1)
      .max(50)
      .optional()
      .describe(
        "Maximum number of playlists to return (1-50). Defaults to 20."
      ),
  },
  handler: async (args) => {
    const { limit = 20 } = args;

    try {
      const path = "/v1/me/playlists";
      const queryParams = { limit: limit };

      const playlists = await handleSpotifyRequest<SpotifyUserPlaylists>(
        "GET",
        path,
        queryParams
      );

      if (!playlists?.items || playlists.items.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: "You don't have any playlists on Spotify or an error occurred retrieving them.",
            },
          ],
        };
      }

      const formattedPlaylists = playlists.items
        .map((playlist, i) => {
          const tracksTotal = playlist.tracks?.total ?? 0;
          return `${i + 1}. "${
            playlist.name || "Unknown Playlist"
          }" (${tracksTotal} track${tracksTotal === 1 ? "" : "s"}) by ${
            playlist.owner?.display_name || "Unknown Owner"
          } - ID: ${playlist.id}`;
        })
        .join("\n");

      return {
        content: [
          {
            type: "text",
            text: `# Your Spotify Playlists (limit: ${limit})\n\n${formattedPlaylists}`,
          },
        ],
      };
    } catch (error) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `Error getting user playlists: ${
              error instanceof Error ? error.message : String(error)
            }`,
          },
        ],
      };
    }
  },
};

const getPlaylistTracks: tool<{
  playlistId: z.ZodString;
  limit: z.ZodOptional<z.ZodNumber>;
}> = {
  name: "getPlaylistTracks",
  description:
    "Get a list of tracks in a Spotify playlist. Provide the playlist ID. Returns track name, artist, duration, and Spotify ID.",
  schema: {
    playlistId: z.string().describe("The Spotify ID of the playlist."),
    limit: z
      .number()
      .min(1)
      .max(50)
      .optional()
      .describe("Maximum number of tracks to return (1-50). Defaults to 50."),
  },
  handler: async (args) => {
    const { playlistId, limit = 50 } = args;

    try {
      const path = `/v1/playlists/${playlistId}/tracks`;
      const queryParams = { limit: limit };

      const playlistTracks = await handleSpotifyRequest<SpotifyPlaylistItems>(
        "GET",
        path,
        queryParams
      );

      if (!playlistTracks?.items || playlistTracks.items.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: `Playlist (ID: ${playlistId}) doesn't have any tracks or an error occurred retrieving them.`,
            },
          ],
        };
      }

      const formattedTracks = playlistTracks.items
        .map((item, i) => {
          const { track } = item;
          if (!track)
            return `${i + 1}. [Removed track or item could not be retrieved]`;

          if (isTrack(track)) {
            const artists =
              track.artists?.map((a) => a.name).join(", ") ||
              "Unknown Artist(s)";
            const duration = formatDuration(track.duration_ms);
            return `${i + 1}. "${
              track.name || "Unknown Track"
            }" by ${artists} (${duration}) - ID: ${track.id}`;
          }

          return `${i + 1}. Unknown item type in playlist`;
        })
        .join("\n");

      return {
        content: [
          {
            type: "text",
            text: `# Tracks in Playlist (ID: ${playlistId}, limit: ${limit})\n\n${formattedTracks}`,
          },
        ],
      };
    } catch (error) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `Error getting playlist tracks: ${
              error instanceof Error ? error.message : String(error)
            }`,
          },
        ],
      };
    }
  },
};

const getRecentlyPlayed: tool<{
  limit: z.ZodOptional<z.ZodNumber>;
}> = {
  name: "getRecentlyPlayed",
  description:
    "Get a list of recently played tracks on Spotify. Returns track name, artist, duration, and Spotify ID.",
  schema: {
    limit: z
      .number()
      .min(1)
      .max(50)
      .optional()
      .describe("Maximum number of tracks to return (1-50). Defaults to 20."),
  },
  handler: async (args) => {
    const { limit = 20 } = args;

    try {
      const path = "/v1/me/player/recently-played";
      const queryParams = { limit: limit };

      const history = await handleSpotifyRequest<SpotifyRecentlyPlayed>(
        "GET",
        path,
        queryParams
      );

      if (!history?.items || history.items.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: "You don't have any recently played tracks on Spotify or an error occurred retrieving them.",
            },
          ],
        };
      }

      const formattedHistory = history.items
        .map((item, i) => {
          const track = item.track;
          if (!track)
            return `${i + 1}. [Removed track or item could not be retrieved]`;

          if (isTrack(track)) {
            const artists =
              track.artists?.map((a) => a.name).join(", ") ||
              "Unknown Artist(s)";
            const duration = formatDuration(track.duration_ms);
            return `${i + 1}. "${
              track.name || "Unknown Track"
            }" by ${artists} (${duration}) - ID: ${track.id}`;
          }

          return `${i + 1}. Unknown item type in history`;
        })
        .join("\n");

      return {
        content: [
          {
            type: "text",
            text: `# Recently Played Tracks (limit: ${limit})\n\n${formattedHistory}`,
          },
        ],
      };
    } catch (error) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `Error getting recently played tracks: ${
              error instanceof Error ? error.message : String(error)
            }`,
          },
        ],
      };
    }
  },
};

const followPlaylist: tool<{
  playlistId: z.ZodString;
  public: z.ZodOptional<z.ZodBoolean>;
}> = {
  name: "followPlaylist",
  description:
    "Follow a Spotify playlist for the current user. Provide the playlist ID.",
  schema: {
    playlistId: z
      .string()
      .describe("The Spotify ID of the playlist to follow."),
    public: z
      .boolean()
      .optional()
      .describe(
        "If true, the playlist will be included in user's public playlists (added to profile), if false it will remain private. Defaults to true."
      ),
  },
  handler: async (args) => {
    const { playlistId, public: isPublic = true } = args;

    try {
      const path = `/v1/playlists/${playlistId}/followers`;
      const body = { public: isPublic };

      await handleSpotifyRequest<undefined>("PUT", path, undefined, body);

      return {
        content: [
          {
            type: "text",
            text: `Successfully followed playlist (ID: ${playlistId}).`,
          },
        ],
      };
    } catch (error) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `Error following playlist (ID: ${playlistId}): ${
              error instanceof Error ? error.message : String(error)
            }`,
          },
        ],
      };
    }
  },
};

const unfollowPlaylist: tool<{
  playlistId: z.ZodString;
}> = {
  name: "unfollowPlaylist",
  description:
    "Unfollow a Spotify playlist for the current user. Provide the playlist ID.",
  schema: {
    playlistId: z
      .string()
      .describe("The Spotify ID of the playlist to unfollow."),
  },
  handler: async (args) => {
    const { playlistId } = args;

    try {
      const path = `/v1/playlists/${playlistId}/followers`;
      await handleSpotifyRequest<undefined>(
        "DELETE",
        path,
        undefined,
        undefined
      );

      return {
        content: [
          {
            type: "text",
            text: `Successfully unfollowed playlist (ID: ${playlistId}).`,
          },
        ],
      };
    } catch (error) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `Error unfollowing playlist (ID: ${playlistId}): ${
              error instanceof Error ? error.message : String(error)
            }`,
          },
        ],
      };
    }
  },
};

const followArtistsOrUsers: tool<{
  type: z.ZodEnum<["artist", "user"]>;
  ids: z.ZodArray<z.ZodString>;
}> = {
  name: "followArtistsOrUsers",
  description:
    "Follow one or more Spotify artists or users for the current user. Provide type ('artist' or 'user') and an array of IDs.",
  schema: {
    type: z
      .enum(["artist", "user"])
      .describe("The type of item to follow: 'artist' or 'user'."),
    ids: z
      .array(z.string())
      .min(1)
      .max(50)
      .describe("An array of Spotify artist or user IDs to follow (max 50)."),
  },
  handler: async (args) => {
    const { type, ids } = args;

    try {
      const path = "/v1/me/following";
      const queryParams = { type: type };
      const body = { ids: ids };

      await handleSpotifyRequest<undefined>("PUT", path, queryParams, body);

      return {
        content: [
          {
            type: "text",
            text: `Successfully followed ${ids.length} ${type}${
              ids.length === 1 ? "" : "s"
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
            text: `Error following ${type}s: ${
              error instanceof Error ? error.message : String(error)
            }`,
          },
        ],
      };
    }
  },
};

const unfollowArtistsOrUsers: tool<{
  type: z.ZodEnum<["artist", "user"]>;
  ids: z.ZodArray<z.ZodString>;
}> = {
  name: "unfollowArtistsOrUsers",
  description:
    "Unfollow one or more Spotify artists or users for the current user. Provide type ('artist' or 'user') and an array of IDs.",
  schema: {
    type: z
      .enum(["artist", "user"])
      .describe("The type of item to unfollow: 'artist' or 'user'."),
    ids: z
      .array(z.string())
      .min(1)
      .max(50)
      .describe("An array of Spotify artist or user IDs to unfollow (max 50)."),
  },
  handler: async (args) => {
    const { type, ids } = args;

    try {
      const path = "/v1/me/following";
      const queryParams = { type: type };
      const body = { ids: ids };

      await handleSpotifyRequest<undefined>("DELETE", path, queryParams, body);

      return {
        content: [
          {
            type: "text",
            text: `Successfully unfollowed ${ids.length} ${type}${
              ids.length === 1 ? "" : "s"
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
            text: `Error unfollowing ${type}s: ${
              error instanceof Error ? error.message : String(error)
            }`,
          },
        ],
      };
    }
  },
};

const saveTracks: tool<{
  ids: z.ZodArray<z.ZodString>;
}> = {
  name: "saveTracks",
  description:
    'Save one or more tracks to the current user\'s \'Your Music\' library. Provide an array of Spotify track IDs using the key \'ids\'. For example: {"ids": ["id1", "id2"]}.', // Added clarity to description
  schema: {
    ids: z
      .array(z.string())
      .min(1)
      .max(50)
      .describe("An array of Spotify track IDs to save (max 50)."),
  },
  handler: async (args) => {
    const { ids } = args;

    try {
      const path = "/v1/me/tracks";
      // FIX: Spotify API expects { "ids": [...] } in the body
      const body = { ids };

      // Assuming handleSpotifyRequest correctly handles PUT with JSON body

      await handleSpotifyRequest<undefined>("PUT", path, undefined, body);

      return {
        content: [
          {
            type: "text",
            text: `Successfully saved ${ids.length} track${
              ids.length === 1 ? "" : "s"
            } to your library.`,
          },
        ],
      };
    } catch (error) {
      // Check if the error might be from the Spotify API itself
      // You might want to add more specific error handling based on API response codes
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      console.error("Error in saveTracks handler:", errorMessage); // Log the error

      return {
        isError: true,
        content: [
          {
            type: "text",
            // Provide a more user-friendly message, maybe suggest trying again
            text: `Failed to save tracks. Please try again later. Details: ${errorMessage}`,
          },
        ],
      };
    }
  },
};

const removeSavedTracks: tool<{
  ids: z.ZodArray<z.ZodString>;
}> = {
  name: "removeSavedTracks",
  description:
    "Remove one or more tracks from the current user's 'Your Music' library. Provide an array of track IDs.",
  schema: {
    ids: z
      .array(z.string())
      .min(1)
      .max(50)
      .describe("An array of Spotify track IDs to remove (max 50)."),
  },
  handler: async (args) => {
    const { ids } = args;

    try {
      const path = "/v1/me/tracks";
      const body = { ids };

      await handleSpotifyRequest<undefined>("DELETE", path, undefined, body);

      return {
        content: [
          {
            type: "text",
            text: `Successfully removed ${ids.length} track${
              ids.length === 1 ? "" : "s"
            } from your library.`,
          },
        ],
      };
    } catch (error) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `Error removing tracks: ${
              error instanceof Error ? error.message : String(error)
            }`,
          },
        ],
      };
    }
  },
};

const checkIfUserFollowsArtistsOrUsers: tool<{
  type: z.ZodEnum<["artist", "user"]>;
  ids: z.ZodArray<z.ZodString>;
}> = {
  name: "checkIfUserFollowsArtistsOrUsers",
  description:
    "Check if the current user is following one or more Spotify artists or users. Provide type ('artist' or 'user') and an array of IDs.",
  schema: {
    type: z
      .enum(["artist", "user"])
      .describe("The type of item to check: 'artist' or 'user'."),
    ids: z
      .array(z.string())
      .min(1)
      .max(50)
      .describe("An array of Spotify artist or user IDs to check (max 50)."),
  },
  handler: async (args) => {
    const { type, ids } = args;

    try {
      const path = "/v1/me/following/contains";
      const queryParams = { type: type, ids: ids.join(",") };

      const results = await handleSpotifyRequest<boolean[]>(
        "GET",
        path,
        queryParams
      );

      if (!results) {
        return {
          isError: true,
          content: [
            { type: "text", text: `Error checking if user follows ${type}s.` },
          ],
        };
      }

      const formattedResults = ids
        .map((id, i) => `${id}: ${results[i] ? "Following" : "Not Following"}`)
        .join("\n");

      return {
        content: [
          {
            type: "text",
            text: `# User Follow Status (${type}s):\n\n${formattedResults}`,
          },
        ],
      };
    } catch (error) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `Error checking user follow status for ${type}s: ${
              error instanceof Error ? error.message : String(error)
            }`,
          },
        ],
      };
    }
  },
};

const checkIfUserFollowsPlaylist: tool<{
  playlistId: z.ZodString;
}> = {
  name: "checkIfUserFollowsPlaylist",
  description:
    "Check if the current user is following a specific Spotify playlist. Provide the playlist ID.",
  schema: {
    playlistId: z.string().describe("The Spotify ID of the playlist to check."),
  },
  handler: async (args) => {
    const { playlistId } = args;

    try {
      const path = `/v1/playlists/${playlistId}/followers/contains`;
      // Usar el ID del usuario actual en el query param 'ids' es más seguro
      // que solo 'me', aunque 'me' a veces funciona.
      // Necesitaríamos obtener el ID del usuario primero (como en createPlaylist).
      // Para simplificar, mantengamos 'ids: "me"' si la API lo sigue soportando.
      // Alternativa robusta: obtener ID del usuario, luego llamar a esta API.
      // Por ahora, mantenemos 'ids: "me"' para que coincida con el código anterior,
      // pero con la nota que puede ser inestable si la API deja de soportar 'me'.
      const queryParams = { ids: "me" };

      const results = await handleSpotifyRequest<boolean[]>(
        "GET",
        path,
        queryParams
      );

      if (!results || results.length === 0) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Error checking if user follows playlist (ID: ${playlistId}).`,
            },
          ],
        };
      }

      const isFollowing = results[0];

      return {
        content: [
          {
            type: "text",
            text: `User ${
              isFollowing ? "is" : "is not"
            } following playlist (ID: ${playlistId}).`,
          },
        ],
      };
    } catch (error) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `Error checking user follow status for playlist (ID: ${playlistId}): ${
              error instanceof Error ? error.message : String(error)
            }`,
          },
        ],
      };
    }
  },
};

const checkUsersSavedTracks: tool<{
  trackIds: z.ZodArray<z.ZodString>;
}> = {
  name: "checkUsersSavedTracks",
  description:
    "Check if one or more tracks are saved in the current user's 'Your Music' library. Provide an array of track IDs.",
  schema: {
    trackIds: z
      .array(z.string())
      .min(1)
      .max(50)
      .describe("An array of Spotify track IDs to check (max 50)."),
  },
  handler: async (args) => {
    const { trackIds } = args;

    try {
      const path = "/v1/me/tracks/contains";
      const queryParams = { ids: trackIds.join(",") };

      const results = await handleSpotifyRequest<boolean[]>(
        "GET",
        path,
        queryParams
      );

      if (!results || results.length === 0) {
        return {
          isError: true,
          content: [
            { type: "text", text: `Error checking if tracks are saved.` },
          ],
        };
      }

      const formattedResults = trackIds
        .map((id, i) => `${id}: ${results[i] ? "Saved" : "Not Saved"}`)
        .join("\n");

      return {
        content: [
          { type: "text", text: `# Track Save Status:\n\n${formattedResults}` },
        ],
      };
    } catch (error) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `Error checking track save status: ${
              error instanceof Error ? error.message : String(error)
            }`,
          },
        ],
      };
    }
  },
};

export const readTools = [
  searchSpotify,
  getNowPlaying,
  getMyPlaylists,
  getPlaylistTracks,
  getRecentlyPlayed,
  followPlaylist,
  unfollowPlaylist,
  followArtistsOrUsers,
  unfollowArtistsOrUsers,
  saveTracks,
  removeSavedTracks,
  checkIfUserFollowsArtistsOrUsers,
  checkIfUserFollowsPlaylist,
  checkUsersSavedTracks,
];
