// ============================================================
// HANDLERS — Endpoints para el frontend
// Cada handler envuelve un servicio y devuelve JSON.
//
// Contrato:
//   Éxito:  { exito: true, data: ... }
//   Error:  { exito: false, error: "mensaje" }
// ============================================================

// ============================================================
// HELPERS DE RESPUESTA
// ============================================================
function _ok_(data) {
  return { exito: true, data: data };
}

function _err_(mensaje) {
  return { exito: false, error: String(mensaje) };
}

function _runHandler_(fn) {
  try {
    const resultado = fn();
    return _ok_(resultado);
  } catch (e) {
    Logger.log("Handler error: " + e.message + "\n" + (e.stack || ""));
    return _err_(e.message);
  }
}

// ============================================================
// AUTENTICACIÓN
// ============================================================
function apiLoginPropietario(edificio, apartamento, email) {
  return _runHandler_(function() {
    if (!edificio || !apartamento || !email) {
      throw new Error("Faltan datos: edificio, apartamento y correo.");
    }

    // 1. Condominio (v1: el primero)
    const conds = RepoCondominios.listarTodos();
    if (!conds.length) throw new Error("No hay condominio configurado.");
    // Buscar el condominio que contenga ese edificio
let cond = null;
for (const c of conds) {
  const edfTest = sb.select("edificios",
    "condominio_id=eq." + c.id +
    "&nombre=eq." + encodeURIComponent(edificio) +
    "&activo=eq.true&limit=1");
  if (edfTest && edfTest.length) { cond = c; break; }
}
if (!cond) throw new Error("No se encontró el condominio para ese edificio.");;

    // 2. Buscar edificio
    const edfs = sb.select("edificios",
      "condominio_id=eq." + cond.id +
      "&nombre=eq." + encodeURIComponent(edificio) +
      "&activo=eq.true");
    if (!edfs.length) throw new Error("Edificio no encontrado.");
    const edf = edfs[0];

    // 3. Buscar inmueble
    const inms = sb.select("inmuebles",
      "edificio_id=eq." + edf.id +
      "&codigo=eq." + encodeURIComponent(apartamento) +
      "&activo=eq.true");
    if (!inms.length) throw new Error("Apartamento no encontrado.");
    const inm = inms[0];

    // 4. Buscar propietario
    const props = sb.select("propiedad_inmueble",
      "inmueble_id=eq." + inm.id + "&order=desde.desc&limit=1");
    if (!props.length) throw new Error("Este inmueble no tiene propietario registrado.");

    const persona = RepoPersonas.porId(props[0].persona_id);
    if (!persona) throw new Error("Propietario no encontrado.");
    if (!persona.email) throw new Error("El propietario no tiene correo registrado.");

    // 5. Verificar email (v1: sin contraseña)
    if (String(persona.email).toLowerCase() !== String(email).trim().toLowerCase()) {
      throw new Error("El correo no coincide con el propietario de este inmueble.");
    }

     return {
      inmuebleId: inm.id,
      condominioId: cond.id,
      personaId: persona.id,
      condominioNombre: cond.nombre,
      edificio: edf.nombre,
      apartamento: inm.codigo,
      alicuota: parseFloat(inm.alicuota),
      propietario: persona.nombre,
      email: persona.email,
      esAdmin: false
    };
  });
}

function apiLoginAdmin(condominioId, clave) {
  return _runHandler_(function() {
    if (!clave) throw new Error("Falta la clave de administrador.");

    // v1: clave en PropertiesService
    const props = PropertiesService.getScriptProperties();
    const claveAdmin = props.getProperty("ADMIN_CLAVE") || "admin123";

    if (String(clave) !== String(claveAdmin)) {
      throw new Error("Clave de administrador incorrecta.");
    }

    // Devolver el condominio
    let cond;
    if (condominioId) {
      cond = RepoCondominios.porId(condominioId);
      if (!cond) throw new Error("Condominio no encontrado.");
    } else {
      const conds = RepoCondominios.listarTodos();
      if (!conds.length) throw new Error("No hay condominio configurado.");
      cond = conds[0];
    }

    return {
      condominioId: cond.id,
      condominioNombre: cond.nombre,
      propietario: "Administrador",
      esAdmin: true
    };
  });
}

// ============================================================
// CONFIGURACIÓN INICIAL
// ============================================================
function apiConfiguracionInicial() {
  return _runHandler_(function() {
    const conds = RepoCondominios.listarTodos();
    if (!conds.length) throw new Error("No hay condominio configurado.");
    const cond = conds[0];

    // Edificios e inmuebles
    const mapaInmuebles = {};
    const edfs = sb.select("edificios",
      "condominio_id=eq." + cond.id + "&activo=eq.true&order=orden.asc,nombre.asc");
    edfs.forEach(e => {
      const inms = sb.select("inmuebles",
        "edificio_id=eq." + e.id + "&activo=eq.true&order=codigo.asc");
      mapaInmuebles[e.nombre] = inms.map(i => i.codigo);
    });

    // Categorías de gasto
    const cats = RepoCategoriasGasto.listarPorCondominio(cond.id);

    // Cuota base vigente
    const cuotaBase = RepoCuotasBase.vigente(cond.id);

    // Periodo fiscal
    const periodo = RepoPeriodosFiscales.abiertoPorCondominio(cond.id);

    // Bancos (catálogo simple en JSON)
    const bancos = ["Banesco", "Banco de Venezuela", "Mercantil", "Provincial", "BOD", "Bancamiga", "BNC", "Otro"];

    return {
      condominio: {
        id: cond.id,
        nombre: cond.nombre,
        email: cond.email,
        rif: cond.rif || ""
      },
      inmuebles: mapaInmuebles,
      categorias: cats.map(c => ({ id: c.id, nombre: c.nombre, modo: c.modo_cobro })),
      cuotaBase: cuotaBase ? parseFloat(cuotaBase.monto) : 0,
      anioFiscal: periodo ? periodo.anio : new Date().getFullYear(),
      bancos: bancos
    };
  });
}

// ============================================================
// DASHBOARD
// ============================================================
function apiDashboardPropietario(inmuebleId) {
  return _runHandler_(function() {
    if (!inmuebleId) throw new Error("Falta inmuebleId");
    return ServicioDashboard.dashboardPropietario(inmuebleId);
  });
}

function apiDashboardAdmin(condominioId) {
  return _runHandler_(function() {
    if (!condominioId) throw new Error("Falta condominioId");
    return ServicioDashboard.dashboardAdmin(condominioId);
  });
}

function apiSaldoConsolidado(inmuebleId) {
  return _runHandler_(function() {
    if (!inmuebleId) throw new Error("Falta inmuebleId");
    return ServicioDashboard.saldoConsolidado(inmuebleId);
  });
}

// ============================================================
// PAGOS
// ============================================================
function apiRegistrarPago(datos) {
  return _runHandler_(function() {
    if (!datos) throw new Error("Faltan datos del pago");

    const resultado = ServicioPagos.registrar({
      condominioId: datos.condominioId,
      inmuebleId: datos.inmuebleId,
      personaId: datos.personaId || null,
      fechaPago: datos.fechaPago,
      monto: parseFloat(datos.monto),
      moneda: datos.moneda || "BS",
      referencia: datos.referencia,
      banco: datos.banco || null,
      archivoId: datos.archivoId || null
    });

    return {
      pagoId: resultado.pago.id,
      estado: resultado.pago.estado,
      mensaje: resultado.mensaje
    };
  });
}

function apiConciliarPago(pagoId, opciones) {
  return _runHandler_(function() {
    if (!pagoId) throw new Error("Falta pagoId");
    return ServicioPagos.conciliar(pagoId, opciones || { modo: "FIFO" });
  });
}

function apiAnularPago(pagoId, motivo) {
  return _runHandler_(function() {
    if (!pagoId) throw new Error("Falta pagoId");
    return ServicioPagos.anular(pagoId, motivo || "Sin motivo especificado");
  });
}

function apiListarPagosInmueble(inmuebleId) {
  return _runHandler_(function() {
    if (!inmuebleId) throw new Error("Falta inmuebleId");
    const pagos = RepoPagos.listarPorInmueble(inmuebleId);
    return pagos.map(p => ({
      id: p.id,
      fecha: p.fecha_pago,
      monto: parseFloat(p.monto_bs),
      moneda: p.moneda,
      referencia: p.referencia,
      banco: p.banco,
      estado: p.estado
    }));
  });
}

function apiListarPagosCondominio(condominioId, filtros) {
  return _runHandler_(function() {
    if (!condominioId) throw new Error("Falta condominioId");
    const pagos = RepoPagos.listarPorCondominio(condominioId, filtros || {});
    return pagos.map(p => ({
      id: p.id,
      inmueble: p.inmueble ? p.inmueble.codigo : null,
      fecha: p.fecha_pago,
      monto: parseFloat(p.monto_bs),
      referencia: p.referencia,
      banco: p.banco,
      estado: p.estado
    }));
  });
}

function apiVerificarReferencia(referencia) {
  return _runHandler_(function() {
    if (!referencia) throw new Error("Falta referencia");
    // Referencia es UNIQUE globalmente, buscar en cualquier condominio
    const res = sb.select("pagos",
      "referencia=eq." + encodeURIComponent(referencia) + "&limit=1");
    return {
      existe: res && res.length > 0,
      pago: res && res.length ? {
        id: res[0].id,
        estado: res[0].estado
      } : null
    };
  });
}

// ============================================================
// CUOTAS
// ============================================================
function apiGenerarCuotasMes(condominioId, opciones) {
  return _runHandler_(function() {
    if (!condominioId) throw new Error("Falta condominioId");
    if (!opciones || !opciones.concepto) throw new Error("Falta concepto");
    return ServicioCuotas.generarCuotasDelMes(condominioId, opciones);
  });
}

function apiPrevisualizarCuotas(condominioId, opciones) {
  return _runHandler_(function() {
    if (!condominioId) throw new Error("Falta condominioId");
    return ServicioCuotas.previsualizar(condominioId, opciones);
  });
}

function apiListarCuotasInmueble(inmuebleId, filtros) {
  return _runHandler_(function() {
    if (!inmuebleId) throw new Error("Falta inmuebleId");
    const cuotas = RepoCuotas.listarPorInmueble(inmuebleId, filtros || {});
    return cuotas.map(c => ({
      id: c.id,
      concepto: c.concepto,
      tipo: c.tipo,
      monto: parseFloat(c.monto_original),
      pagado: parseFloat(c.monto_pagado),
      saldo: parseFloat(c.saldo),
      estado: c.estado,
      fechaEmision: c.fecha_emision,
      fechaVencimiento: c.fecha_vencimiento
    }));
  });
}

function apiAnularCuotasMes(condominioId, concepto) {
  return _runHandler_(function() {
    if (!condominioId) throw new Error("Falta condominioId");
    if (!concepto) throw new Error("Falta concepto");
    return ServicioCuotas.anularCuotasDelMes(condominioId, concepto);
  });
}

// ============================================================
// EGRESOS
// ============================================================
function apiRegistrarEgresoOperativo(datos) {
  return _runHandler_(function() {
    if (!datos) throw new Error("Faltan datos del egreso");

    return ServicioEgresos.registrarOperativo({
      condominioId: datos.condominioId,
      categoriaId: datos.categoriaId,
      proveedorId: datos.proveedorId || null,
      fecha: datos.fecha,
      descripcion: datos.descripcion,
      monto: parseFloat(datos.monto),
      moneda: datos.moneda || "BS",
      archivoVoucherId: datos.archivoVoucherId || null,
      archivoFacturaId: datos.archivoFacturaId || null,
      referencia: datos.referencia || null
    });
  });
}

function apiRegistrarProyecto(datos) {
  return _runHandler_(function() {
    if (!datos) throw new Error("Faltan datos del proyecto");
    return ServicioEgresos.registrarProyecto({
      condominioId: datos.condominioId,
      categoriaId: datos.categoriaId,
      descripcion: datos.descripcion,
      montoEstimado: parseFloat(datos.montoEstimado),
      moneda: datos.moneda || "BS",
      archivoProyectoId: datos.archivoProyectoId || null
    });
  });
}

function apiPresentarAsamblea(egresoId, fechaAsamblea) {
  return _runHandler_(function() {
    if (!egresoId) throw new Error("Falta egresoId");
    return ServicioEgresos.presentarAsamblea(egresoId, fechaAsamblea);
  });
}

function apiAprobarProyecto(egresoId, montoAprobado) {
  return _runHandler_(function() {
    if (!egresoId) throw new Error("Falta egresoId");
    return ServicioEgresos.aprobarProyecto(egresoId, montoAprobado);
  });
}

function apiIniciarEjecucion(egresoId) {
  return _runHandler_(function() {
    if (!egresoId) throw new Error("Falta egresoId");
    return ServicioEgresos.iniciarEjecucion(egresoId);
  });
}

function apiValidarObra(egresoId, datos) {
  return _runHandler_(function() {
    if (!egresoId) throw new Error("Falta egresoId");
    return ServicioEgresos.validarObra(egresoId, datos || {});
  });
}

function apiPagarProyecto(egresoId, datos) {
  return _runHandler_(function() {
    if (!egresoId) throw new Error("Falta egresoId");
    return ServicioEgresos.pagarProyecto(egresoId, datos || {});
  });
}

function apiGenerarRepartoDirecto(datos) {
  return _runHandler_(function() {
    if (!datos) throw new Error("Faltan datos del reparto");
    return ServicioEgresos.generarRepartoDirecto({
      condominioId: datos.condominioId,
      categoriaId: datos.categoriaId,
      descripcion: datos.descripcion,
      monto: parseFloat(datos.monto),
      moneda: datos.moneda || "BS",
      fechaVencimiento: datos.fechaVencimiento
    });
  });
}

function apiListarEgresos(condominioId, filtros) {
  return _runHandler_(function() {
    if (!condominioId) throw new Error("Falta condominioId");
    const egresos = RepoEgresos.listarConCategoria(condominioId, filtros || {});
    return egresos.map(e => ({
      id: e.id,
      fecha: e.fecha,
      descripcion: e.descripcion,
      monto: parseFloat(e.monto_final || e.monto),
      categoria: e.categoria ? e.categoria.nombre : null,
      modoCobro: e.modo_cobro,
      estado: e.estado,
      referencia: e.referencia
    }));
  });
}

function apiAnularEgreso(egresoId, motivo) {
  return _runHandler_(function() {
    if (!egresoId) throw new Error("Falta egresoId");
    return ServicioEgresos.anular(egresoId, motivo);
  });
}

// ============================================================
// CONCILIACIÓN BANCARIA
// ============================================================
function apiCargarExtracto(condominioId, textoPlano, banco) {
  return _runHandler_(function() {
    if (!condominioId) throw new Error("Falta condominioId");
    if (!textoPlano || !textoPlano.trim()) throw new Error("Falta texto del extracto");
    return ServicioConciliacion.cargarExtracto(condominioId, textoPlano, banco);
  });
}

function apiConciliarAutomaticamente(condominioId) {
  return _runHandler_(function() {
    if (!condominioId) throw new Error("Falta condominioId");
    return ServicioConciliacion.conciliarAutomaticamente(condominioId);
  });
}

function apiConciliarManual(movimientoId, pagoId) {
  return _runHandler_(function() {
    if (!movimientoId) throw new Error("Falta movimientoId");
    if (!pagoId) throw new Error("Falta pagoId");
    return ServicioConciliacion.conciliarManual(movimientoId, pagoId);
  });
}

function apiMarcarHuerfanoIgnorado(movimientoId, nota) {
  return _runHandler_(function() {
    if (!movimientoId) throw new Error("Falta movimientoId");
    return ServicioConciliacion.marcarIgnorado(movimientoId, nota);
  });
}

function apiResumenConciliacion(condominioId) {
  return _runHandler_(function() {
    if (!condominioId) throw new Error("Falta condominioId");
    return ServicioConciliacion.resumen(condominioId);
  });
}

function apiListarHuerfanos(condominioId) {
  return _runHandler_(function() {
    if (!condominioId) throw new Error("Falta condominioId");
    const huerfanos = ServicioConciliacion.listarHuerfanos(condominioId);
    return huerfanos.map(h => ({
      id: h.id,
      fecha: h.fecha,
      referencia: h.referencia,
      descripcion: h.descripcion,
      monto: parseFloat(h.monto),
      nota: h.nota,
      tipo: parseFloat(h.monto) > 0 ? "INGRESO" : "EGRESO"
    }));
  });
}

// ============================================================
// MORA
// ============================================================
function apiActualizarMora(condominioId) {
  return _runHandler_(function() {
    if (!condominioId) throw new Error("Falta condominioId");
    return ServicioMora.actualizarMoraDelCondominio(condominioId);
  });
}

function apiCuotasEnMora(condominioId) {
  return _runHandler_(function() {
    if (!condominioId) throw new Error("Falta condominioId");
    return ServicioMora.cuotasEnMora(condominioId);
  });
}

function apiEstadoCuentaConMora(inmuebleId) {
  return _runHandler_(function() {
    if (!inmuebleId) throw new Error("Falta inmuebleId");
    return ServicioMora.estadoCuentaConMora(inmuebleId);
  });
}

// ============================================================
// NOTIFICACIONES
// ============================================================
function apiNotificarMora(condominioId) {
  return _runHandler_(function() {
    if (!condominioId) throw new Error("Falta condominioId");
    return ServicioNotificaciones.notificarMora(condominioId);
  });
}

function apiEnviarComunicado(condominioId, asunto, cuerpo) {
  return _runHandler_(function() {
    if (!condominioId) throw new Error("Falta condominioId");
    if (!asunto) throw new Error("Falta asunto");
    if (!cuerpo) throw new Error("Falta cuerpo");
    return ServicioNotificaciones.enviarComunicado(condominioId, asunto, cuerpo);
  });
}

function apiListarNotificaciones(condominioId, limite) {
  return _runHandler_(function() {
    if (!condominioId) throw new Error("Falta condominioId");
    const notifs = sb.select("notificaciones",
      "condominio_id=eq." + condominioId +
      "&order=created_at.desc&limit=" + (limite || 20));
    return notifs.map(n => ({
      id: n.id,
      tipo: n.tipo,
      destinatario: n.email_destino,
      asunto: n.asunto,
      estado: n.estado,
      fecha: n.created_at,
      error: n.error
    }));
  });
}

// ============================================================
// FONDOS
// ============================================================
function apiSaldoFondos(condominioId) {
  return _runHandler_(function() {
    if (!condominioId) throw new Error("Falta condominioId");
    return {
      operativo: RepoFondoOperativo.saldo(condominioId),
      reserva: RepoFondoReserva.saldo(condominioId)
    };
  });
}

function apiMovimientosFondos(condominioId, tipo, limite) {
  return _runHandler_(function() {
    if (!condominioId) throw new Error("Falta condominioId");

    const filtros = { };
    const repo = tipo === "reserva" ? RepoFondoReserva : RepoFondoOperativo;
    const movs = repo.listarPorCondominio(condominioId, filtros);

    return movs.slice(0, limite || 50).map(m => ({
      id: m.id,
      fecha: m.fecha,
      tipo: m.tipo,
      monto: parseFloat(m.monto),
      moneda: m.moneda || "BS",
      origenTipo: m.origen_tipo,
      descripcion: m.descripcion
    }));
  });
}

// ============================================================
// EDIFICIOS E INMUEBLES (para selects)
// ============================================================
function apiListarEdificios(condominioId) {
  return _runHandler_(function() {
    if (!condominioId) throw new Error("Falta condominioId");
    const edfs = RepoEdificios.listarPorCondominio(condominioId);
    return edfs.map(e => ({
      id: e.id,
      nombre: e.nombre,
      orden: e.orden
    }));
  });
}

function apiListarInmuebles(edificioId) {
  return _runHandler_(function() {
    if (!edificioId) throw new Error("Falta edificioId");
    const inms = RepoInmuebles.listarPorEdificio(edificioId);
    return inms.map(i => ({
      id: i.id,
      codigo: i.codigo,
      alicuota: parseFloat(i.alicuota)
    }));
  });
}

function apiListarCategorias(condominioId) {
  return _runHandler_(function() {
    if (!condominioId) throw new Error("Falta condominioId");
    const cats = RepoCategoriasGasto.listarPorCondominio(condominioId);
    return cats.map(c => ({
      id: c.id,
      nombre: c.nombre,
      modoCobro: c.modo_cobro
    }));
  });
}

// ============================================================
// ASISTENTE IA
// ============================================================
function apiConsultarAsistente(pregunta) {
  return _runHandler_(function() {
    if (!pregunta) throw new Error("Falta pregunta");
    const respuesta = procesarConsultaUsuario(pregunta);
    return { respuesta: respuesta };
  });
}



function testHandlers1() {
  Logger.log("=== TEST Handlers Bloque 1 ===");

  // 1. Configuración inicial
  Logger.log("\n--- apiConfiguracionInicial ---");
  const cfg = apiConfiguracionInicial();
  if (cfg.exito) {
    Logger.log("Condominio: " + cfg.data.condominio.nombre);
    Logger.log("Edificios: " + Object.keys(cfg.data.inmuebles).length);
    Logger.log("Categorías: " + cfg.data.categorias.length);
    Logger.log("Cuota base: Bs " + cfg.data.cuotaBase);
    Logger.log("Bancos: " + cfg.data.bancos.length);
  } else {
    Logger.log("Error: " + cfg.error);
    Logger.log("(Normal: no hay condominio configurado todavía)");
  }

  Logger.log("\n=== FIN ===");
}

function testHandlers2() {
  Logger.log("=== TEST Handlers Bloque 2 ===");

  Logger.log("\n--- Verificar que las funciones existen ---");
  Logger.log("apiRegistrarPago: " + (typeof apiRegistrarPago === "function"));
  Logger.log("apiConciliarPago: " + (typeof apiConciliarPago === "function"));
  Logger.log("apiAnularPago: " + (typeof apiAnularPago === "function"));
  Logger.log("apiGenerarCuotasMes: " + (typeof apiGenerarCuotasMes === "function"));
  Logger.log("apiRegistrarEgresoOperativo: " + (typeof apiRegistrarEgresoOperativo === "function"));
  Logger.log("apiRegistrarProyecto: " + (typeof apiRegistrarProyecto === "function"));
  Logger.log("apiAprobarProyecto: " + (typeof apiAprobarProyecto === "function"));
  Logger.log("apiIniciarEjecucion: " + (typeof apiIniciarEjecucion === "function"));
  Logger.log("apiValidarObra: " + (typeof apiValidarObra === "function"));
  Logger.log("apiPagarProyecto: " + (typeof apiPagarProyecto === "function"));
  Logger.log("apiGenerarRepartoDirecto: " + (typeof apiGenerarRepartoDirecto === "function"));
  Logger.log("apiListarEgresos: " + (typeof apiListarEgresos === "function"));
  Logger.log("apiAnularEgreso: " + (typeof apiAnularEgreso === "function"));

  Logger.log("\n--- Verificar contrato de error ---");
  const r1 = apiRegistrarPago(null);
  Logger.log("apiRegistrarPago(null): exito=" + r1.exito + " error=" + r1.error);

  const r2 = apiConciliarPago(null);
  Logger.log("apiConciliarPago(null): exito=" + r2.exito + " error=" + r2.error);

  const r3 = apiAnularPago(null);
  Logger.log("apiAnularPago(null): exito=" + r3.exito + " error=" + r3.error);

  Logger.log("\n=== FIN ===");
}

function testHandlers3() {
  Logger.log("=== TEST Handlers Bloque 3 ===");

  Logger.log("\n--- Verificar existencia de handlers ---");
  const handlers = [
    "apiCargarExtracto",
    "apiConciliarAutomaticamente",
    "apiConciliarManual",
    "apiMarcarHuerfanoIgnorado",
    "apiResumenConciliacion",
    "apiListarHuerfanos",
    "apiActualizarMora",
    "apiCuotasEnMora",
    "apiEstadoCuentaConMora",
    "apiNotificarMora",
    "apiEnviarComunicado",
    "apiListarNotificaciones",
    "apiSaldoFondos",
    "apiMovimientosFondos",
    "apiListarEdificios",
    "apiListarInmuebles",
    "apiListarCategorias",
    "apiConsultarAsistente"
  ];

  handlers.forEach(h => {
    Logger.log("  " + h + ": " + (typeof this[h] === "function"));
  });

  Logger.log("\n--- Contrato de error ---");
  const errores = [
    ["apiCargarExtracto", null, null, null],
    ["apiConciliarAutomaticamente", null],
    ["apiActualizarMora", null],
    ["apiSaldoFondos", null]
  ];

  errores.forEach(([nombre, ...args]) => {
    const r = this[nombre].apply(this, args);
    Logger.log(nombre + ": exito=" + r.exito + " error=" + (r.error || "—"));
  });

  Logger.log("\n=== FIN ===");
}



// ============================================================
// PROCESAMIENTO DE COMPROBANTES CON IA
// ============================================================
function apiProcesarComprobantePago(base64, mimeType) {
  return _runHandler_(function() {
    if (!base64) throw new Error("Falta el comprobante");

    // Llamar al servicio de IA (Vision)
    const resultado = analizarComprobanteBancario(base64, mimeType);
    if (resultado.error) throw new Error(resultado.error);

    return resultado;
  });
}

function apiProcesarFacturaGasto(base64, mimeType) {
  return _runHandler_(function() {
    if (!base64) throw new Error("Falta la factura");
    const resultado = analizarFacturaGasto(base64, mimeType);
    if (resultado.error) throw new Error(resultado.error);
    return resultado;
  });
}

// ============================================================
// REGISTRAR PAGO CON COMPROBANTE (flujo completo)
// Sube el archivo a Storage, crea el archivo, y crea el pago.
// ============================================================
function apiRegistrarPagoConComprobante(datos, base64, mimeType) {
  return _runHandler_(function() {
    if (!datos) throw new Error("Faltan datos del pago");
    if (!base64) throw new Error("Falta el comprobante");
    if (!datos.condominioId) throw new Error("Falta condominioId");
    if (!datos.inmuebleId) throw new Error("Falta inmuebleId");

    // 1. Armar ruta del archivo
    const ahora = new Date();
    const anio = ahora.getFullYear();
    const mes = String(ahora.getMonth() + 1).padStart(2, "0");
    const ts = ahora.getTime();
    const ext = mimeType === "image/png" ? "png" : "jpg";
    const path = datos.condominioId + "/pagos/" + anio + "-" + mes + "/" +
                 ts + "_" + datos.referencia + "." + ext;

    // 2. Subir a Storage
    const subida = SupabaseStorage.subir("comprobantes", path, base64, mimeType);

    // 3. Crear registro en tabla archivos
    const tamano = Math.round((base64.length * 3) / 4 / 1024); // aprox KB
    const archivoRes = sb.insert("archivos", {
      condominio_id: datos.condominioId,
      storage_path: subida.path,
      bucket: "comprobantes",
      nombre_original: datos.nombreArchivo || "comprobante.jpg",
      mime_type: mimeType,
      size_bytes: tamano * 1024,
      uploaded_by: datos.personaId || null
    });

    const archivoId = archivoRes && archivoRes.length ? archivoRes[0].id : null;

    // 4. Registrar el pago
        const resultado = ServicioPagos.registrar({
      condominioId: datos.condominioId,
      inmuebleId: datos.inmuebleId,
      personaId: datos.personaId || null,
      fechaPago: datos.fechaPago,
      monto: parseFloat(datos.monto),
      moneda: datos.moneda || "BS",
      referencia: datos.referencia,
      banco: datos.banco || null,
      archivoId: archivoId,
      mes: datos.mes,
      anio: datos.anio
    });

    return {
      pagoId: resultado.pago.id,
      archivoId: archivoId,
      estado: resultado.pago.estado,
      mensaje: resultado.mensaje
    };
  });
}

// ============================================================
// REGISTRAR EGRESO OPERATIVO CON COMPROBANTE
// ============================================================
function apiRegistrarEgresoOperativoConComprobante(datos, base64Voucher, mimeVoucher, base64Factura, mimeFactura) {
  return _runHandler_(function() {
    if (!datos) throw new Error("Faltan datos del egreso");
    if (!base64Voucher) throw new Error("Falta el comprobante bancario");
    if (!datos.condominioId) throw new Error("Falta condominioId");

    // 1. Subir voucher (obligatorio)
    const ahora = new Date();
    const anio = ahora.getFullYear();
    const mes = String(ahora.getMonth() + 1).padStart(2, "0");
    const ts = ahora.getTime();
    const ext = mimeVoucher === "image/png" ? "png" : "jpg";
    const pathVoucher = datos.condominioId + "/egresos/" + anio + "-" + mes + "/" +
                        ts + "_voucher_" + (datos.referencia || "sn") + "." + ext;

    const subidaVoucher = SupabaseStorage.subir("comprobantes", pathVoucher, base64Voucher, mimeVoucher);

    const archivoVoucherRes = sb.insert("archivos", {
      condominio_id: datos.condominioId,
      storage_path: subidaVoucher.path,
      bucket: "comprobantes",
      nombre_original: "voucher.jpg",
      mime_type: mimeVoucher,
      size_bytes: Math.round((base64Voucher.length * 3) / 4),
      uploaded_by: null
    });
    const archivoVoucherId = archivoVoucherRes && archivoVoucherRes.length ? archivoVoucherRes[0].id : null;

    // 2. Subir factura (opcional)
    let archivoFacturaId = null;
    if (base64Factura) {
      const extF = mimeFactura === "image/png" ? "png" : mimeFactura === "application/pdf" ? "pdf" : "jpg";
      const pathFactura = datos.condominioId + "/facturas/" + anio + "-" + mes + "/" +
                          ts + "_factura_" + (datos.referencia || "sn") + "." + extF;

      const subidaFactura = SupabaseStorage.subir("facturas", pathFactura, base64Factura, mimeFactura);

      const archivoFacturaRes = sb.insert("archivos", {
        condominio_id: datos.condominioId,
        storage_path: subidaFactura.path,
        bucket: "facturas",
        nombre_original: "factura." + extF,
        mime_type: mimeFactura,
        size_bytes: Math.round((base64Factura.length * 3) / 4),
        uploaded_by: null
      });
      archivoFacturaId = archivoFacturaRes && archivoFacturaRes.length ? archivoFacturaRes[0].id : null;
    }

    // 3. Registrar el egreso operativo
    const resultado = ServicioEgresos.registrarOperativo({
      condominioId: datos.condominioId,
      categoriaId: datos.categoriaId,
      proveedorId: datos.proveedorId || null,
      fecha: datos.fecha,
      descripcion: datos.descripcion,
      monto: parseFloat(datos.monto),
      moneda: datos.moneda || "BS",
      archivoVoucherId: archivoVoucherId,
      archivoFacturaId: archivoFacturaId,
      referencia: datos.referencia
    });

    return {
      egresoId: resultado.egreso.id,
      archivoVoucherId: archivoVoucherId,
      archivoFacturaId: archivoFacturaId,
      estado: resultado.egreso.estado,
      mensaje: resultado.mensaje
    };
  });
}