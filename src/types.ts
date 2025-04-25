// src/types.ts
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type {
  ServerNotification,
  ServerRequest,
} from "@modelcontextprotocol/sdk/types.js";
import type { z } from "zod";

// Tipo genérico para la estructura de una herramienta MCP
export type tool<Args extends z.ZodRawShape> = {
  name: string; // Nombre único de la herramienta
  description: string; // Descripción para el LLM
  schema: Args; // Esquema Zod para los argumentos
  handler: (
    // Función manejadora de la herramienta
    args: z.infer<z.ZodObject<Args>>, // Argumentos parseados por Zod
    extra: RequestHandlerExtra<ServerRequest, ServerNotification> // Objeto de contexto del SDK
  ) =>
    | Promise<{
        // El manejador debe devolver una promesa de CallToolResult
        content: Array<{
          type: "text"; // O "image", "audio", "resource" según la especificación MCP
          text: string;
        }>;
        isError?: boolean; // Indica si la ejecución de la herramienta resultó en un error
      }>
    | {
        // O directamente un CallToolResult (si no es asíncrono, pero la mayoría de llamadas API son)
        content: Array<{
          type: "text";
          text: string;
        }>;
        isError?: boolean;
      };
};

// Interfaces para tipos de datos comunes de Spotify (pueden necesitar ajustes finos)
export interface SpotifyArtist {
  id: string;
  name: string;
}

export interface SpotifyAlbum {
  id: string;
  name: string;
  artists: SpotifyArtist[];
}

export interface SpotifyTrack {
  id: string;
  name: string;
  type: string;
  duration_ms: number;
  artists: SpotifyArtist[];
  album: SpotifyAlbum;
}
export interface SimplifiedShowObject {
  id: string;
  name: string;
  description: string;
  // Añadir otros campos si se necesitan (e.g., type, external_urls, languages, total_episodes)
}

// Interfaz para un Episodio simplificado (resultados de búsqueda)
export interface SimplifiedEpisodeObject {
  id: string;
  name: string;
  description: string;
  duration_ms: number;
  release_date: string;
  // show: SimplifiedShowObject; // Puede incluir una referencia al show, pero a menudo no en resultados de búsqueda
  // Añadir otros campos si se necesitan (e.g., type, external_urls, language, audio_preview_url)
}
// Añadir interfaces para tipos de respuesta de la API que vamos a usar
// Basado en la documentación que proporcionaste
export interface SpotifySearchResults {
  tracks?: { items: SpotifyTrack[] };
  albums?: { items: SpotifyAlbum[] & { artists: SpotifyArtist[] }[] }; // Ajustar para tener artistas
  artists?: {
    items: SpotifyArtist[] &
      { popularity?: number; followers?: { total: number } }[];
  }; // Ajustar si es necesario, solo nombre/id por ahora
  playlists?: { items: SpotifyPlaylist[] };
  shows?: {
    items: SimplifiedShowObject[];
    href?: string;
    limit?: number;
    next?: string | null;
    offset?: number;
    previous?: string | null;
    total: number;
  };
  episodes?: {
    items: SimplifiedEpisodeObject[];
    href?: string;
    limit?: number;
    next?: string | null;
    offset?: number;
    previous?: string | null;
    total: number;
  };
}

export interface SpotifyPlaylist {
  id: string;
  name: string;
  description?: string;
  owner: { display_name?: string; id: string };
  public?: boolean;
  tracks?: { total: number };
}

export interface SpotifyCurrentlyPlaying {
  item: SpotifyTrack | null; // Puede ser null o un podcast. ¡Ojo! La API puede devolver otros tipos!
  is_playing: boolean;
  progress_ms: number | null;
}

// Añadir una interfaz básica para otros tipos de items que no son tracks (ej: Episode, Ad)
// Esto es útil para manejar el tipo 'item' en SpotifyCurrentlyPlaying de forma más robusta.
export interface BasicSpotifyItem {
  id?: string;
  type?: string; // 'track', 'episode', 'ad', etc.
  name?: string;
  duration_ms?: number;
  // Añadir otras propiedades comunes si se necesitan, como 'uri', 'external_urls', etc.
}

export interface SpotifyUserPlaylists {
  items: SpotifyPlaylist[];
  // Añadir campos de paginación si se van a usar (href, limit, next, offset, previous, total)
}

export interface SpotifyPlaylistItems {
  items: { track: SpotifyTrack | null }[]; // item.track puede ser null. ¡Ojo! La API puede devolver otros tipos de items aquí también!
  // Añadir campos de paginación si se van a usar
}

export interface SpotifyRecentlyPlayed {
  items: { track: SpotifyTrack; played_at: string }[]; // ¡Ojo! La API puede devolver otros tipos de items aquí también!
  // Añadir campos de paginación si se van a usar
}

export interface SpotifyUserProfile {
  id: string;
  display_name?: string;
  // ... otros campos del perfil si se necesitan
}

// Añadir interfaces para manejar errores de la API de Spotify
export interface SpotifyApiError {
  error: {
    status: number;
    message: string;
  };
}
/*
# Currently Paused

**Track**: "If You Don't Want My Love"
**Artist**: Jalen Ngonda
**Album**: Come Around and Love Me
**Progress**: 0:09 / 2:27
**ID**: 4A48ckONJNoXU5smWT9CeG
*/
