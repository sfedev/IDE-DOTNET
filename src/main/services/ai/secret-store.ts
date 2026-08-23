/**
 * Almacén de claves de API.
 *
 * Las claves se cifran con `safeStorage` de Electron, que delega en el llavero del sistema
 * operativo: DPAPI en Windows y Keychain en macOS. El archivo que queda en `userData` contiene
 * cifrado opaco, no la clave.
 *
 * Cuando el sistema no ofrece cifrado —puede pasar en una sesión de Linux sin llavero— **no se
 * escribe nada en disco**: la clave vive sólo en memoria durante la sesión y la interfaz lo
 * advierte. Guardar un secreto en claro en el perfil del usuario "para que sea cómodo" es
 * exactamente la clase de decisión que se paga años después (ADR-019).
 *
 * La clave nunca cruza al renderer. El renderer puede escribirla y borrarla; para leerla sólo hay
 * un consumidor, que es el cliente HTTP del propio proceso principal.
 */
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { safeStorage } from 'electron';

import type { AiProviderId } from '../../../shared/ai.js';
import { AI_PROVIDER_IDS } from '../../../shared/ai.js';

let storePath = '';

/** Claves en claro, sólo en memoria. Nunca se serializa este mapa tal cual. */
const secrets = new Map<AiProviderId, string>();

export function initialize(userDataPath: string): void {
  storePath = join(userDataPath, 'ai-credentials.json');
}

export function isEncryptionAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    // Fuera de Electron (pruebas, scripts) no hay llavero: se comporta como si no lo hubiera.
    return false;
  }
}

function isProvider(value: string): value is AiProviderId {
  return (AI_PROVIDER_IDS as readonly string[]).includes(value);
}

/** Lee y descifra el almacén. Un archivo ilegible se ignora: se pedirá la clave otra vez. */
export async function load(): Promise<void> {
  secrets.clear();
  if (storePath === '' || !existsSync(storePath) || !isEncryptionAvailable()) return;

  try {
    const raw: unknown = JSON.parse(await readFile(storePath, 'utf8'));
    if (typeof raw !== 'object' || raw === null) return;

    for (const [provider, value] of Object.entries(raw as Record<string, unknown>)) {
      if (!isProvider(provider) || typeof value !== 'string') continue;
      try {
        const decrypted = safeStorage.decryptString(Buffer.from(value, 'base64'));
        if (decrypted.trim() !== '') secrets.set(provider, decrypted);
      } catch {
        // Cifrado de otra máquina o de otro usuario: no se puede descifrar y no es un error.
      }
    }
  } catch {
    // Archivo corrupto: se arranca sin credenciales en vez de no arrancar.
  }
}

export function get(provider: AiProviderId): string | null {
  return secrets.get(provider) ?? null;
}

export function configuredProviders(): AiProviderId[] {
  return AI_PROVIDER_IDS.filter((provider) => secrets.has(provider));
}

/** Guarda (o borra, con `null`) la clave de un proveedor. Devuelve si ha quedado persistida. */
export async function set(provider: AiProviderId, apiKey: string | null): Promise<boolean> {
  const value = apiKey?.trim() ?? '';

  if (value === '') secrets.delete(provider);
  else secrets.set(provider, value);

  if (!isEncryptionAvailable()) return false;

  if (secrets.size === 0) {
    await rm(storePath, { force: true });
    return true;
  }

  const payload: Record<string, string> = {};
  for (const [id, secret] of secrets) {
    payload[id] = safeStorage.encryptString(secret).toString('base64');
  }

  await mkdir(dirname(storePath), { recursive: true });
  await writeFile(storePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return true;
}
