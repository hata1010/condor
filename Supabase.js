// ============================================================
// CLIENTE SUPABASE — Conexión a la base de datos
// ============================================================
let MODO_TEST_ = false;
/**
 * Realiza una petición HTTP a Supabase.
 */
function sbFetch_(endpoint, opciones) {
  opciones = opciones || {};
  const props = PropertiesService.getScriptProperties();
  const urlBase = props.getProperty("SUPABASE_URL");

  const key = opciones.useSecret === false
    ? props.getProperty("SUPABASE_PUBLISHABLE")
    : props.getProperty("SUPABASE_SECRET");

  if (!urlBase || !key) {
    throw new Error("Faltan credenciales Supabase en PropertiesService.");
  }

  let url = urlBase + "/rest/v1/" + endpoint;
  if (opciones.query) {
    url += "?" + opciones.query;
  }

  const headers = {
    "apikey": key,
    "Authorization": "Bearer " + key,
    "Content-Type": "application/json",
    "Prefer": opciones.prefer || "return=representation"
  };

  // Si estamos en modo test, marcar la petición
  if (MODO_TEST_) {
    headers["X-Modo-Test"] = "true";
  }
   
  const fetchOpts = {
    method: opciones.method || "get",
    headers: headers,
    muteHttpExceptions: true
  };

  if (opciones.body) {
    fetchOpts.payload = JSON.stringify(opciones.body);
  }

  const res = UrlFetchApp.fetch(url, fetchOpts);
  const code = res.getResponseCode();
  const texto = res.getContentText();

  if (code >= 400) {
    throw new Error("Supabase " + code + ": " + texto.substring(0, 300));
  }

  if (!texto || texto.trim() === "") {
    return null;
  }

  return JSON.parse(texto);
}

/**
 * API de alto nivel.
 */
const sb = {
  select: function(tabla, query) {
    return sbFetch_(tabla, { method: "get", query: query });
  },
  insert: function(tabla, filas) {
    return sbFetch_(tabla, {
      method: "post",
      body: Array.isArray(filas) ? filas : [filas]
    });
  },
  update: function(tabla, query, cambios) {
    return sbFetch_(tabla + (query ? "?" + query : ""), {
      method: "patch",
      body: cambios
    });
  },
  delete: function(tabla, query) {
    return sbFetch_(tabla + (query ? "?" + query : ""), {
      method: "delete"
    });
  },
  upsert: function(tabla, filas, onConflict) {
  const query = onConflict ? "on_conflict=" + onConflict : "";
  return sbFetch_(tabla + (query ? "?" + query : ""), {
    method: "post",
    body: Array.isArray(filas) ? filas : [filas],
    prefer: "resolution=merge-duplicates,return=representation"
  });
  }
};

/**
 * TEST — Verifica que GAS puede hablar con Supabase.
 * Esperado: código 200.
 */
function testConexionSupabase() {
  try {
    const props = PropertiesService.getScriptProperties();
    const url = props.getProperty("SUPABASE_URL");
    const key = props.getProperty("SUPABASE_SECRET");

    Logger.log("Probando conexión a: " + url);

    const res = UrlFetchApp.fetch(url + "/rest/v1/", {
      method: "get",
      headers: {
        "apikey": key,
        "Authorization": "Bearer " + key
      },
      muteHttpExceptions: true
    });

    const code = res.getResponseCode();
    Logger.log("Código HTTP: " + code);
    Logger.log("Respuesta: " + res.getContentText().substring(0, 200));

    if (code === 200) {
      Logger.log("✅ CONEXIÓN EXITOSA");
    } else if (code === 401) {
      Logger.log("⚠️ Código 401: la key es incorrecta.");
    } else if (code === 404) {
      Logger.log("⚠️ Código 404: la URL o el endpoint no existen.");
    } else {
      Logger.log("⚠️ Código inesperado: " + code);
    }
  } catch (e) {
    Logger.log("❌ Error: " + e.message);
  }
}

/**
 * TEST — Inserta un condominio de prueba en Supabase.
 * Devuelve el registro creado (con su id).
 */
function testInsertarCondominio() {
  try {
    const nuevo = {
      nombre: "Condominio Prueba",
      rif: "J-12345678-9",
      direccion: "Av. Principal, Caracas",
      telefono: "+58 212 1234567",
      email: "admin@condominio-prueba.com",
      condicion: "ACTIVO"
    };

    Logger.log("Insertando condominio: " + nuevo.nombre);

    const res = sb.insert("condominios", nuevo);

    Logger.log("Respuesta: " + JSON.stringify(res, null, 2));
    Logger.log("✅ Condominio insertado con id: " + res[0].id);
  } catch (e) {
    Logger.log("❌ Error: " + e.message);
  }
}
/**
 * TEST — Lee todos los condominios de Supabase.
 */
function testLeerCondominios() {
  try {
    const condominios = sb.select("condominios", "order=created_at.desc");

    Logger.log("Total condominios: " + condominios.length);
    condominios.forEach(c => {
      Logger.log("  - " + c.nombre + " (" + c.email + ")");
    });
  } catch (e) {
    Logger.log("❌ Error: " + e.message);
  }
}

/**
 * TEST — Actualiza el condominio de prueba.
 */
function testActualizarCondominio() {
  try {
    const lista = sb.select("condominios", "nombre=eq.Condominio Prueba");
    if (!lista || !lista.length) {
      Logger.log("No se encontró el condominio.");
      return;
    }

    const id = lista[0].id;
    Logger.log("Actualizando condominio id: " + id);

    const res = sb.update(
      "condominios",
      "id=eq." + id,
      { telefono: "+58 212 9999999" }
    );

    Logger.log("Respuesta: " + JSON.stringify(res, null, 2));
    Logger.log("✅ Actualizado");
  } catch (e) {
    Logger.log("❌ Error: " + e.message);
  }
}

/**
 * TEST — Borra el condominio de prueba.
 */
function testBorrarCondominioPrueba() {
  try {
    const res = sb.delete("condominios", "nombre=eq.Condominio Prueba");
    Logger.log("Borrados: " + (res ? res.length : 0));
    Logger.log("✅ Limpieza completada");
  } catch (e) {
    Logger.log("❌ Error: " + e.message);
  }
}

function testLatenciaSupabase() {
  Logger.log("=== Latencia hacia Supabase ===");
  
  const tiempos = [];
  for (let i = 0; i < 5; i++) {
    const t0 = new Date().getTime();
    sb.select("condominios", "limit=1");
    const t1 = new Date().getTime();
    tiempos.push(t1 - t0);
    Logger.log("Llamada " + (i+1) + ": " + (t1 - t0) + " ms");
  }
  
  const promedio = Math.round(tiempos.reduce((s,t) => s+t, 0) / tiempos.length);
  Logger.log("─────────────────");
  Logger.log("Promedio: " + promedio + " ms por llamada");
  
  if (promedio < 500) {
    Logger.log("✅ Supabase rápido. El cuello es GAS o el código.");
  } else if (promedio < 1500) {
    Logger.log("⚠️ Latencia elevada pero aceptable.");
  } else {
    Logger.log("🔴 Latencia muy alta. Revisar red o Supabase.");
  }
}
