// ============================================================
// REPOSITORIOS — NÚCLEO
// Soft delete universal (CRUD-in): nunca se borra, solo se
// marca inactivo. Las FKs usan ON DELETE RESTRICT.
// ============================================================

// ------------------------------------------------------------
// CONDOMINIOS
// ------------------------------------------------------------
const RepoCondominios = {
  listar: function() {
    return sb.select("condominios",
      "condicion=eq.ACTIVO&order=nombre.asc");
  },

  listarTodos: function() {
    return sb.select("condominios", "order=nombre.asc");
  },

  porId: function(id) {
    const res = sb.select("condominios", "id=eq." + id);
    return res && res.length ? res[0] : null;
  },

  porNombre: function(nombre) {
    const res = sb.select("condominios",
      "nombre=eq." + encodeURIComponent(nombre));
    return res && res.length ? res[0] : null;
  },

  crear: function(datos) {
    const res = sb.insert("condominios", datos);
    return res && res.length ? res[0] : null;
  },

  actualizar: function(id, cambios) {
    const res = sb.update("condominios", "id=eq." + id, cambios);
    return res && res.length ? res[0] : null;
  },

  eliminar: function(id) {
    return this.actualizar(id, { condicion: "INACTIVO" });
  },

  reactivar: function(id) {
    return this.actualizar(id, { condicion: "ACTIVO" });
  }
};

// ------------------------------------------------------------
// EDIFICIOS
// ------------------------------------------------------------
const RepoEdificios = {
  listarPorCondominio: function(condominioId) {
    return sb.select("edificios",
      "condominio_id=eq." + condominioId +
      "&activo=eq.true&order=orden.asc,nombre.asc");
  },

  listarTodosPorCondominio: function(condominioId) {
    return sb.select("edificios",
      "condominio_id=eq." + condominioId + "&order=orden.asc,nombre.asc");
  },

  porId: function(id) {
    const res = sb.select("edificios", "id=eq." + id);
    return res && res.length ? res[0] : null;
  },

  porNombre: function(condominioId, nombre) {
    const res = sb.select("edificios",
      "condominio_id=eq." + condominioId +
      "&nombre=eq." + encodeURIComponent(nombre));
    return res && res.length ? res[0] : null;
  },

  crear: function(datos) {
    const res = sb.insert("edificios", datos);
    return res && res.length ? res[0] : null;
  },

  actualizar: function(id, cambios) {
    const res = sb.update("edificios", "id=eq." + id, cambios);
    return res && res.length ? res[0] : null;
  },

  eliminar: function(id) {
    return this.actualizar(id, { activo: false });
  },

  reactivar: function(id) {
    return this.actualizar(id, { activo: true });
  }
};

// ------------------------------------------------------------
// INMUEBLES
// ------------------------------------------------------------
const RepoInmuebles = {
  listarPorEdificio: function(edificioId) {
    return sb.select("inmuebles",
      "edificio_id=eq." + edificioId +
      "&activo=eq.true&order=codigo.asc");
  },

  listarConEdificio: function(condominioId) {
    return sb.select("inmuebles",
      "select=*,edificio:edificio_id!inner(id,nombre,condominio_id)" +
      "&edificio.condominio_id=eq." + condominioId +
      "&activo=eq.true&order=codigo.asc");
  },

  porId: function(id) {
    const res = sb.select("inmuebles", "id=eq." + id);
    return res && res.length ? res[0] : null;
  },

  porCodigo: function(edificioId, codigo) {
    const res = sb.select("inmuebles",
      "edificio_id=eq." + edificioId +
      "&codigo=eq." + encodeURIComponent(codigo));
    return res && res.length ? res[0] : null;
  },

  crear: function(datos) {
    const res = sb.insert("inmuebles", datos);
    return res && res.length ? res[0] : null;
  },

  actualizar: function(id, cambios) {
    const res = sb.update("inmuebles", "id=eq." + id, cambios);
    return res && res.length ? res[0] : null;
  },

  eliminar: function(id) {
    return this.actualizar(id, { activo: false });
  },

  reactivar: function(id) {
    return this.actualizar(id, { activo: true });
  }
};

// ------------------------------------------------------------
// PERSONAS
// ------------------------------------------------------------
const RepoPersonas = {
  listarPorCondominio: function(condominioId) {
    return sb.select("personas",
      "condominio_id=eq." + condominioId +
      "&activo=eq.true&order=nombre.asc");
  },

  porId: function(id) {
    const res = sb.select("personas", "id=eq." + id);
    return res && res.length ? res[0] : null;
  },

  porCedula: function(condominioId, cedula) {
    const res = sb.select("personas",
      "condominio_id=eq." + condominioId +
      "&cedula=eq." + encodeURIComponent(cedula));
    return res && res.length ? res[0] : null;
  },

  porEmail: function(condominioId, email) {
    const res = sb.select("personas",
      "condominio_id=eq." + condominioId +
      "&email=eq." + encodeURIComponent(email));
    return res && res.length ? res[0] : null;
  },

  crear: function(datos) {
    const res = sb.insert("personas", datos);
    return res && res.length ? res[0] : null;
  },

  actualizar: function(id, cambios) {
    const res = sb.update("personas", "id=eq." + id, cambios);
    return res && res.length ? res[0] : null;
  },

  eliminar: function(id) {
    return this.actualizar(id, { activo: false });
  },

  reactivar: function(id) {
    return this.actualizar(id, { activo: true });
  }
};

// ------------------------------------------------------------
// ROLES (catálogo global, sin soft delete)
// ------------------------------------------------------------
const RepoRoles = {
  listar: function() {
    return sb.select("roles", "order=nombre.asc");
  },

  porId: function(id) {
    const res = sb.select("roles", "id=eq." + id);
    return res && res.length ? res[0] : null;
  },

  porNombre: function(nombre) {
    const res = sb.select("roles",
      "nombre=eq." + encodeURIComponent(nombre));
    return res && res.length ? res[0] : null;
  }
};

// ------------------------------------------------------------
// USUARIOS
// ------------------------------------------------------------
const RepoUsuarios = {
  porId: function(id) {
    const res = sb.select("usuarios", "id=eq." + id);
    return res && res.length ? res[0] : null;
  },

  porPersona: function(personaId) {
    const res = sb.select("usuarios", "persona_id=eq." + personaId);
    return res && res.length ? res[0] : null;
  },

  crear: function(datos) {
    const res = sb.insert("usuarios", datos);
    return res && res.length ? res[0] : null;
  },

  actualizar: function(id, cambios) {
    const res = sb.update("usuarios", "id=eq." + id, cambios);
    return res && res.length ? res[0] : null;
  },

  eliminar: function(id) {
    return this.actualizar(id, { activo: false });
  },

  reactivar: function(id) {
    return this.actualizar(id, { activo: true });
  },

  registrarAcceso: function(id) {
    return this.actualizar(id, {
      ultimo_acceso: new Date().toISOString(),
      intentos_fallidos: 0
    });
  },

  registrarIntentoFallido: function(id, intentosActuales) {
    return this.actualizar(id, {
      intentos_fallidos: (intentosActuales || 0) + 1
    });
  },

  listarRoles: function(usuarioId) {
    return sb.select("usuario_roles",
      "usuario_id=eq." + usuarioId +
      "&select=rol:rol_id(id,nombre,descripcion)");
  },

  asignarRol: function(usuarioId, rolId) {
    return sb.insert("usuario_roles", {
      usuario_id: usuarioId,
      rol_id: rolId
    });
  },

  quitarRol: function(usuarioId, rolId) {
    // Quitar rol SÍ es hard delete (es relación N:M, no entidad)
    return sb.delete("usuario_roles",
      "usuario_id=eq." + usuarioId + "&rol_id=eq." + rolId);
  }
};

// ============================================================
// TEST — Repos del Núcleo con soft delete
// ============================================================
function testReposNucleo() {
  Logger.log("=== TEST Repos del Núcleo (soft delete) ===");

  const nombreTest = "Test Repos Nucleo";

  // Limpieza previa
  const previo = RepoCondominios.porNombre(nombreTest);
  if (previo) {
    RepoCondominios.eliminar(previo.id);
  }

  Logger.log("\n--- 1. Crear condominio ---");
  const cond = RepoCondominios.crear({
    nombre: nombreTest,
    email: "test@nucleo.com"
  });
  Logger.log("OK id: " + cond.id);

  Logger.log("\n--- 2. Crear edificio ---");
  const edf = RepoEdificios.crear({
    condominio_id: cond.id,
    nombre: "Edificio A",
    orden: 1
  });
  Logger.log("OK id: " + edf.id);

  Logger.log("\n--- 3. Crear inmueble ---");
  const inm = RepoInmuebles.crear({
    edificio_id: edf.id,
    codigo: "1-A",
    alicuota: 5.5,
    metros: 80
  });
  Logger.log("OK id: " + inm.id);

  Logger.log("\n--- 4. Crear persona ---");
  const per = RepoPersonas.crear({
    condominio_id: cond.id,
    nombre: "Juan Pérez Test",
    cedula: "V-12345678",
    email: "juan@test.com"
  });
  Logger.log("OK id: " + per.id);

  Logger.log("\n--- 5. Crear usuario ---");
  const usr = RepoUsuarios.crear({
    persona_id: per.id,
    password_hash: "$2b$10$hash_de_prueba"
  });
  Logger.log("OK id: " + usr.id);

  Logger.log("\n--- 6. Asignar rol ---");
  const rolProp = RepoRoles.porNombre("PROPIETARIO");
  if (rolProp) {
    RepoUsuarios.asignarRol(usr.id, rolProp.id);
    Logger.log("Roles asignados: " + RepoUsuarios.listarRoles(usr.id).length);
  }

  Logger.log("\n--- 7. Listar activos ---");
  Logger.log("Edificios activos: " + RepoEdificios.listarPorCondominio(cond.id).length);
  Logger.log("Inmuebles activos: " + RepoInmuebles.listarPorEdificio(edf.id).length);
  Logger.log("Personas activas: " + RepoPersonas.listarPorCondominio(cond.id).length);

  Logger.log("\n--- 8. Soft delete (desactivar) ---");
  RepoInmuebles.eliminar(inm.id);
  RepoPersonas.eliminar(per.id);
  RepoEdificios.eliminar(edf.id);
  RepoCondominios.eliminar(cond.id);
  Logger.log("Todo desactivado");

  Logger.log("\n--- 9. Listar activos (debe dar 0) ---");
  Logger.log("Edificios activos: " + RepoEdificios.listarPorCondominio(cond.id).length);
  Logger.log("Inmuebles activos: " + RepoInmuebles.listarPorEdificio(edf.id).length);
  Logger.log("Personas activas: " + RepoPersonas.listarPorCondominio(cond.id).length);

  Logger.log("\n--- 10. Listar TODOS (deben seguir existiendo) ---");
  Logger.log("Edificios totales: " + RepoEdificios.listarTodosPorCondominio(cond.id).length);
  Logger.log("Condominios totales: " + RepoCondominios.listarTodos().filter(c => c.nombre === nombreTest).length);

  Logger.log("\n--- 11. Reactivar ---");
  RepoCondominios.reactivar(cond.id);
  RepoEdificios.reactivar(edf.id);
  RepoInmuebles.reactivar(inm.id);
  RepoPersonas.reactivar(per.id);
  Logger.log("Todo reactivado");

  Logger.log("\n--- 12. Verificar reactivación ---");
  Logger.log("Edificios activos: " + RepoEdificios.listarPorCondominio(cond.id).length);
  Logger.log("Inmuebles activos: " + RepoInmuebles.listarPorEdificio(edf.id).length);
  Logger.log("Personas activas: " + RepoPersonas.listarPorCondominio(cond.id).length);

  Logger.log("\n=== TEST FINALIZADO ===");
  Logger.log("Nota: los datos quedan en BD como activos (no se borran).");
}