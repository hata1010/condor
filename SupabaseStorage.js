// ============================================================
// SUPABASE STORAGE — Subida y manejo de archivos
// ============================================================

const SupabaseStorage = {

  /**
   * Sube un archivo al bucket indicado.
   * @param {string} bucket - nombre del bucket
   * @param {string} path - ruta dentro del bucket (sin barra inicial)
   * @param {string} base64 - contenido en base64 (puede tener prefijo data:)
   * @param {string} mimeType - tipo MIME
   * @return {Object} { exito, path, publicUrl }
   */
  subir: function(bucket, path, base64, mimeType) {
    const props = PropertiesService.getScriptProperties();
    const urlBase = props.getProperty("SUPABASE_URL");
    const key = props.getProperty("SUPABASE_SECRET");

    if (!urlBase || !key) throw new Error("Faltan credenciales Supabase");

    // Limpiar base64
    const limpio = base64.indexOf(",") !== -1 ? base64.split(",")[1] : base64;

    // Crear blob
    const blob = Utilities.newBlob(
      Utilities.base64Decode(limpio),
      mimeType || "image/jpeg",
      path.split("/").pop()
    );

    // Subir
    const url = urlBase + "/storage/v1/object/" + bucket + "/" + path;
    const res = UrlFetchApp.fetch(url, {
      method: "post",
      headers: {
        "apikey": key,
        "Authorization": "Bearer " + key,
        "x-upsert": "false"
      },
      payload: blob,
      muteHttpExceptions: true
    });

    const code = res.getResponseCode();
    const texto = res.getContentText();

    if (code >= 400) {
      throw new Error("Storage " + code + ": " + texto.substring(0, 300));
    }

    return {
      exito: true,
      bucket: bucket,
      path: path,
      url: urlBase + "/storage/v1/object/public/" + bucket + "/" + path
    };
  },

  /**
   * Genera una URL firmada (temporal) para un archivo privado.
   */
  getSignedUrl: function(bucket, path, expiresIn) {
    const props = PropertiesService.getScriptProperties();
    const urlBase = props.getProperty("SUPABASE_URL");
    const key = props.getProperty("SUPABASE_SECRET");

    const url = urlBase + "/storage/v1/object/sign/" + bucket + "/" + path;
    const res = UrlFetchApp.fetch(url, {
      method: "post",
      contentType: "application/json",
      headers: {
        "apikey": key,
        "Authorization": "Bearer " + key
      },
      payload: JSON.stringify({ expiresIn: expiresIn || 3600 }),
      muteHttpExceptions: true
    });

    if (res.getResponseCode() >= 400) {
      throw new Error("Storage sign: " + res.getContentText());
    }

    const json = JSON.parse(res.getContentText());
    return urlBase + "/storage/v1" + json.signedURL;
  }

};