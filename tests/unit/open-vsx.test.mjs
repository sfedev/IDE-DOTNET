/**
 * Pruebas del cliente de Open VSX.
 *
 * Dos cosas importan aquí y las dos son de seguridad tanto como de funcionamiento:
 *
 *  - **La identidad de una extensión acaba siendo un nombre de carpeta y un trozo de URL.** Lo que
 *    no tenga forma de identificador se rechaza antes de llegar a ninguna de las dos.
 *  - **La URL de descarga llega dentro del JSON del registro.** Es texto de la red que acaba
 *    siendo el origen de algo que se escribe en el disco del usuario: si no se comprueba el host,
 *    quien pueda alterar esa respuesta elige de dónde se baja el `.vsix`.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  downloadUrl,
  extensionHue,
  extensionId,
  extensionInitials,
  extensionUrl,
  EXTENSION_CATEGORIES,
  formatDownloads,
  formatRating,
  isTrustedDownload,
  isValidSegment,
  OPEN_VSX_API,
  parseExtension,
  parseExtensionId,
  parseSearch,
  searchUrl,
} from '../../build/ui-lib.mjs';

/** Forma real de `GET /api/-/search`, recortada a los campos que se usan. */
const SEARCH_RESPONSE = {
  offset: 0,
  totalSize: 2,
  extensions: [
    {
      url: 'https://open-vsx.org/api/redhat/java',
      files: {
        download: 'https://open-vsx.org/api/redhat/java/1.32.0/file/redhat.java-1.32.0.vsix',
        icon: 'https://open-vsx.org/api/redhat/java/1.32.0/file/icon.png',
      },
      name: 'java',
      namespace: 'redhat',
      version: '1.32.0',
      timestamp: '2026-05-02T10:00:00Z',
      averageRating: 4.4,
      reviewCount: 213,
      downloadCount: 4_512_000,
      displayName: 'Language Support for Java',
      description: 'Java linting, IntelliSense y refactorización.',
      verified: true,
    },
    {
      files: { download: 'https://open-vsx.org/api/ms-dotnettools/csharp/2.0.0/file/x.vsix' },
      name: 'csharp',
      namespace: 'ms-dotnettools',
      version: '2.0.0',
      downloadCount: 980,
      displayName: 'C#',
      description: '',
    },
  ],
};

describe('identidad de una extensión', () => {
  it('trocea publisher y nombre', () => {
    assert.deepEqual(parseExtensionId('redhat.java'), { namespace: 'redhat', name: 'java' });
  });

  it('admite guiones en el publisher, que es lo normal', () => {
    assert.deepEqual(parseExtensionId('ms-dotnettools.csharp'), {
      namespace: 'ms-dotnettools',
      name: 'csharp',
    });
  });

  it('rechaza lo que no es un identificador', () => {
    for (const value of ['', 'sinpunto', '.java', 'redhat.', '../../etc/passwd', 'a.b.c', 'red hat.java']) {
      assert.equal(parseExtensionId(value), null, `debería rechazar "${value}"`);
    }
  });

  it('el segmento no admite recorridos de ruta ni separadores', () => {
    assert.equal(isValidSegment('java'), true);
    assert.equal(isValidSegment('..'), false);
    assert.equal(isValidSegment('a..b'), false);
    assert.equal(isValidSegment('a/b'), false);
    assert.equal(isValidSegment('a\\b'), false);
  });

  it('compone el identificador canónico', () => {
    assert.equal(extensionId('redhat', 'java'), 'redhat.java');
  });
});

describe('construcción de URLs', () => {
  it('codifica el término de búsqueda', () => {
    const url = new URL(searchUrl({ query: 'c# & razor' }));
    assert.equal(url.origin + url.pathname, `${OPEN_VSX_API}/-/search`);
    assert.equal(url.searchParams.get('query'), 'c# & razor');
  });

  it('sin término ordena por descargas: una lista vacía no enseña nada', () => {
    assert.equal(new URL(searchUrl({})).searchParams.get('sortBy'), 'downloadCount');
    assert.equal(new URL(searchUrl({ query: 'java' })).searchParams.get('sortBy'), 'relevance');
  });

  it('acota el tamaño de página', () => {
    assert.equal(new URL(searchUrl({ size: 5000 })).searchParams.get('size'), '100');
    assert.equal(new URL(searchUrl({ size: 0 })).searchParams.get('size'), '1');
  });

  it('la ficha y la descarga se construyen sobre el API público', () => {
    assert.equal(extensionUrl('redhat', 'java'), `${OPEN_VSX_API}/redhat/java`);
    assert.equal(
      downloadUrl('redhat', 'java', '1.32.0'),
      `${OPEN_VSX_API}/redhat/java/1.32.0/file/redhat.java-1.32.0.vsix`,
    );
  });

  it('un identificador inválido no llega nunca a formar una URL', () => {
    assert.throws(() => extensionUrl('..', 'java'));
    assert.throws(() => downloadUrl('redhat', 'java', '../../..'));
  });

  it('todas las categorías del filtro tienen etiqueta en español', () => {
    assert.ok(EXTENSION_CATEGORIES.length > 5);
    for (const category of EXTENSION_CATEGORIES) {
      assert.equal(typeof category.label, 'string');
      assert.notEqual(category.label.trim(), '');
    }
  });
});

describe('confianza de la descarga', () => {
  it('acepta el registro y su almacén de archivos', () => {
    assert.equal(isTrustedDownload('https://open-vsx.org/api/redhat/java/1.0.0/file/x.vsix'), true);
    assert.equal(isTrustedDownload('https://openvsxorg.blob.core.windows.net/x.vsix'), true);
  });

  it('rechaza HTTP aunque el host sea el bueno', () => {
    assert.equal(isTrustedDownload('http://open-vsx.org/x.vsix'), false);
  });

  /** Contener el host bueno no es ser el host bueno. */
  it('rechaza un host que sólo se le parece', () => {
    assert.equal(isTrustedDownload('https://open-vsx.org.malo.dev/x.vsix'), false);
    assert.equal(isTrustedDownload('https://malo.dev/open-vsx.org/x.vsix'), false);
    assert.equal(isTrustedDownload('https://open-vsx.org.evil/x.vsix'), false);
  });

  it('rechaza lo que no es una URL', () => {
    assert.equal(isTrustedDownload('no es una url'), false);
    assert.equal(isTrustedDownload(''), false);
  });
});

describe('lectura de la respuesta de búsqueda', () => {
  const result = parseSearch(SEARCH_RESPONSE);

  it('lee el total y las extensiones', () => {
    assert.equal(result.total, 2);
    assert.equal(result.extensions.length, 2);
  });

  it('compone el identificador y conserva la descarga declarada', () => {
    const [java] = result.extensions;
    assert.equal(java.id, 'redhat.java');
    assert.equal(java.downloadCount, 4_512_000);
    assert.equal(java.averageRating, 4.4);
    assert.equal(java.verified, true);
    assert.match(java.download, /^https:\/\/open-vsx\.org\/api\/redhat\/java\//);
  });

  /**
   * Si la respuesta trae una descarga que no es de Open VSX, se descarta y se construye la
   * canónica: la alternativa sería bajar el `.vsix` de donde diga un JSON de la red.
   */
  it('descarta una descarga de un host ajeno y construye la canónica', () => {
    const parsed = parseExtension({
      namespace: 'malo',
      name: 'ext',
      version: '1.0.0',
      files: { download: 'https://ejemplo.dev/troyano.vsix' },
    });
    assert.equal(parsed.download, `${OPEN_VSX_API}/malo/ext/1.0.0/file/malo.ext-1.0.0.vsix`);
  });

  it('sin campos obligatorios, la entrada no se lista', () => {
    assert.equal(parseExtension({ namespace: 'x' }), null);
    assert.equal(parseExtension(null), null);
    assert.equal(parseExtension({ namespace: '../x', name: 'y', version: '1.0.0' }), null);
  });

  it('una respuesta que no es la esperada devuelve una lista vacía', () => {
    assert.deepEqual(parseSearch({ error: 'boom' }), { total: 0, offset: 0, extensions: [] });
    assert.deepEqual(parseSearch(null).extensions, []);
  });

  it('sin valoraciones no inventa una', () => {
    const [, csharp] = result.extensions;
    assert.equal(csharp.averageRating, null);
    assert.equal(csharp.reviewCount, 0);
  });
});

describe('presentación', () => {
  it('formatea las descargas de forma compacta y en español', () => {
    assert.equal(formatDownloads(4_512_000), '4,5 M');
    assert.equal(formatDownloads(1_200), '1,2 K');
    assert.equal(formatDownloads(980), '980');
  });

  it('sin valoraciones no pinta estrellas', () => {
    assert.equal(formatRating(null, 0), '');
    assert.equal(formatRating(4.4, 0), '');
  });

  it('con valoraciones pinta estrellas y el número', () => {
    assert.match(formatRating(4.4, 213), /^★★★★½? 4,4$/);
  });

  it('el color del icono es estable para el mismo identificador', () => {
    assert.equal(extensionHue('redhat.java'), extensionHue('redhat.java'));
    assert.notEqual(extensionHue('redhat.java'), extensionHue('ms-dotnettools.csharp'));
  });

  it('las iniciales salen del nombre visible y siempre hay algo', () => {
    assert.equal(extensionInitials('Language Support for Java', 'java'), 'LS');
    assert.equal(extensionInitials('C#', 'csharp'), 'C#');
    assert.equal(extensionInitials('', 'csharp'), 'CS');
  });
});
