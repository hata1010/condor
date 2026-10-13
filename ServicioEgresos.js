// ============================================================
// SERVICIO — EGRESOS
// Maneja los 3 flujos de gasto:
//   1. Operativo   (1 paso, pago inmediato)
//   2. Reserva     (6 pasos, proyecto → asamblea → pago)
//   3. Reparto     (genera cuotas extraordinarias)
// ============================================================

const ServicioEgresos = {

  // ============================================================
  // FLUJO 1 — EGRESO OPERATIVO (1 paso)
  // Ya se pagó al proveedor. Se registra con comprobante.
  // ============================================================
  registrarOperativo: function(datos) {
    if (!datos.condominioId) throw new Error("Falta condominioId");
    if (!datos.categoriaId) throw new Error("Falta categoriaId");
    if (!datos.fecha) throw new Error("Falta fecha");
    if (!datos.descripcion) throw new Error("Falta descripción");
    if (!datos.monto || datos.monto <= 0) throw new Error("Monto inválido");
    if (!datos.archivoVoucherId) throw new Error("Falta comprobante bancario");

    const categoria = RepoCategoriasGasto.porId(datos.categoriaId);
    if (!categoria) throw new Error("Categoría no encontrada");
    if (categoria.modo_cobro !== "FONDO_OPERATIVO") {
      throw new Error("Esta categoría no es de fondo operativo. Modo: " + categoria.modo_cobro);
    }

    // Validar fondo disponible y tope
    this._validarFondoOperativo_(datos.condominioId, datos.monto);

    // Verificar referencia duplicada
    if (datos.referencia) {
      const existente = RepoEgresos.porReferencia(datos.condominioId, datos.referencia);
      if (existente) throw new Error("La referencia ya existe.");
    }

    const periodo = RepoPeriodosFiscales.abiertoPorCondominio(datos.condominioId);

    // Crear el egreso directamente como PAGADO
    const egreso = RepoEgresos.crear({
      condominio_id: datos.condominioId,
      periodo_fiscal_id: periodo ? periodo.id : null,
      fecha: datos.fecha,
      categoria_id: datos.categoriaId,
      proveedor_id: datos.proveedorId || null,
      descripcion: datos.descripcion,
      monto: datos.monto,
      moneda: datos.moneda || "BS",
      modo_cobro: "FONDO_OPERATIVO",
      archivo_voucher_id: datos.archivoVoucherId,
      archivo_factura_id: datos.archivoFacturaId || null,
      referencia: datos.referencia || null,
      estado: "PAGADO",
      fecha_pago: datos.fecha
    });

    // Registrar salida del fondo
    RepoFondoOperativo.registrarSalida({
      condominio_id: datos.condominioId,
      periodo_fiscal_id: periodo ? periodo.id : null,
      fecha: datos.fecha,
      monto: datos.monto,
      origen_tipo: "EGRESO",
      origen_id: egreso.id,
      descripcion: datos.descripcion
    });

    return {
      exito: true,
      egreso: egreso,
      mensaje: "Egreso operativo registrado. Fondo actualizado."
    };
  },

  // ============================================================
  // FLUJO 2 — EGRESO DE RESERVA (6 pasos)
  // ============================================================

  // ----------------------------------------------------------
  // PASO 1 — Registrar proyecto (BORRADOR)
  // ----------------------------------------------------------
  registrarProyecto: function(datos) {
    if (!datos.condominioId) throw new Error("Falta condominioId");
    if (!datos.categoriaId) throw new Error("Falta categoriaId");
    if (!datos.descripcion) throw new Error("Falta descripción");
    if (!datos.montoEstimado || datos.montoEstimado <= 0) throw new Error("Monto estimado inválido");

    const categoria = RepoCategoriasGasto.porId(datos.categoriaId);
    if (!categoria) throw new Error("Categoría no encontrada");

    const periodo = RepoPeriodosFiscales.abiertoPorCondominio(datos.condominioId);
    const hoy = new Date().toISOString().substring(0, 10);

    const egreso = RepoEgresos.crear({
      condominio_id: datos.condominioId,
      periodo_fiscal_id: periodo ? periodo.id : null,
      fecha: hoy,
      categoria_id: datos.categoriaId,
      descripcion: datos.descripcion,
      monto: datos.montoEstimado,
      moneda: datos.moneda || "BS",
      modo_cobro: "FONDO_RESERVA",
      archivo_factura_id: datos.archivoProyectoId || null,
      estado: "BORRADOR",
      fecha_proyecto: hoy
    });

    return { exito: true, egreso: egreso, mensaje: "Proyecto registrado. Estado: BORRADOR." };
  },

  // ----------------------------------------------------------
  // PASO 2 — Presentar a asamblea (EN_ASAMBLEA)
  // ----------------------------------------------------------
  presentarAsamblea: function(egresoId, fechaAsamblea) {
    const egreso = this._obtenerEgreso_(egresoId);
    if (egreso.estado !== "BORRADOR") {
      throw new Error("Solo se puede presentar un proyecto en BORRADOR. Estado: " + egreso.estado);
    }

    const actualizado = RepoEgresos.actualizar(egresoId, {
      estado: "EN_ASAMBLEA",
      fecha_asamblea: fechaAsamblea || new Date().toISOString().substring(0, 10)
    });

    return { exito: true, egreso: actualizado, mensaje: "Proyecto presentado a asamblea." };
  },

  // ----------------------------------------------------------
  // PASO 3 — Aprobar proyecto (APROBADO)
  // ----------------------------------------------------------
  aprobarProyecto: function(egresoId, montoAprobado) {
    const egreso = this._obtenerEgreso_(egresoId);
    if (egreso.estado !== "EN_ASAMBLEA") {
      throw new Error("Solo se puede aprobar un proyecto EN_ASAMBLEA. Estado: " + egreso.estado);
    }

    const monto = montoAprobado || egreso.monto;

    // Validar que el fondo tenga suficiente
    const verificacion = RepoFondoReserva.verificarTope(egreso.condominio_id, monto);
    if (!verificacion.ok) throw new Error(verificacion.motivo);
    if (verificacion.saldo < monto) {
      throw new Error("Fondo de reserva insuficiente. Disponible: Bs " + verificacion.saldo);
    }

    const actualizado = RepoEgresos.actualizar(egresoId, {
      estado: "APROBADO",
      fecha_aprobacion: new Date().toISOString().substring(0, 10),
      monto: monto,
      monto_final: monto
    });

    return { exito: true, egreso: actualizado, mensaje: "Proyecto aprobado." };
  },

  // ----------------------------------------------------------
  // PASO 4 — Iniciar ejecución (EN_EJECUCION)
  // ----------------------------------------------------------
  iniciarEjecucion: function(egresoId) {
    const egreso = this._obtenerEgreso_(egresoId);
    if (egreso.estado !== "APROBADO") {
      throw new Error("Solo se puede iniciar un proyecto APROBADO. Estado: " + egreso.estado);
    }

    const actualizado = RepoEgresos.actualizar(egresoId, {
      estado: "EN_EJECUCION",
      fecha_inicio_ejecucion: new Date().toISOString().substring(0, 10)
    });

    return { exito: true, egreso: actualizado, mensaje: "Obra en ejecución." };
  },

  // ----------------------------------------------------------
  // PASO 5 — Validar obra (VALIDADO)
  // ----------------------------------------------------------
  validarObra: function(egresoId, datos) {
    const egreso = this._obtenerEgreso_(egresoId);
    if (egreso.estado !== "EN_EJECUCION") {
      throw new Error("Solo se puede validar una obra EN_EJECUCION. Estado: " + egreso.estado);
    }

    const actualizado = RepoEgresos.actualizar(egresoId, {
      estado: "VALIDADO",
      fecha_validacion: new Date().toISOString().substring(0, 10),
      validado_por_persona_id: datos.validadoPorPersonaId || null,
      observaciones_validacion: datos.observaciones || null
    });

    return { exito: true, egreso: actualizado, mensaje: "Obra validada. Lista para pago." };
  },

  // ----------------------------------------------------------
  // PASO 6 — Pagar (PAGADO)
  // ----------------------------------------------------------
  pagarProyecto: function(egresoId, datos) {
    const egreso = this._obtenerEgreso_(egresoId);
    if (egreso.estado !== "VALIDADO") {
      throw new Error("Solo se puede pagar un proyecto VALIDADO. Estado: " + egreso.estado);
    }
    if (!datos.archivoVoucherId) throw new Error("Falta comprobante de pago");

    const monto = parseFloat(egreso.monto_final || egreso.monto);
    const periodo = RepoPeriodosFiscales.abiertoPorCondominio(egreso.condominio_id);
    const fechaPago = datos.fechaPago || new Date().toISOString().substring(0, 10);

    // Actualizar el egreso
    const actualizado = RepoEgresos.actualizar(egresoId, {
      estado: "PAGADO",
      fecha_pago: fechaPago,
      archivo_voucher_id: datos.archivoVoucherId,
      proveedor_id: datos.proveedorId || egreso.proveedor_id
    });

    // Registrar salida del fondo de reserva
    RepoFondoReserva.registrarSalida({
      condominio_id: egreso.condominio_id,
      periodo_fiscal_id: periodo ? periodo.id : null,
      fecha: fechaPago,
      moneda: egreso.moneda || "BS",
      monto: monto,
      origen_tipo: "EGRESO_RESERVA",
      origen_id: egresoId,
      descripcion: "Pago proyecto: " + egreso.descripcion,
      aprobado_asamblea: true
    });

    return { exito: true, egreso: actualizado, mensaje: "Proyecto pagado. Fondo de reserva actualizado." };
  },

  // ============================================================
  // FLUJO 3 — REPARTO DIRECTO (genera cuotas)
  // ============================================================
  generarRepartoDirecto: function(datos) {
    if (!datos.condominioId) throw new Error("Falta condominioId");
    if (!datos.categoriaId) throw new Error("Falta categoriaId");
    if (!datos.descripcion) throw new Error("Falta descripción");
    if (!datos.monto || datos.monto <= 0) throw new Error("Monto inválido");
    if (!datos.fechaVencimiento) throw new Error("Falta fecha de vencimiento");

    const categoria = RepoCategoriasGasto.porId(datos.categoriaId);
    if (!categoria) throw new Error("Categoría no encontrada");

    const periodo = RepoPeriodosFiscales.abiertoPorCondominio(datos.condominioId);
    const hoy = new Date().toISOString().substring(0, 10);

    // Crear el egreso (queda APROBADO, esperando cuotas)
    const egreso = RepoEgresos.crear({
      condominio_id: datos.condominioId,
      periodo_fiscal_id: periodo ? periodo.id : null,
      fecha: hoy,
      categoria_id: datos.categoriaId,
      descripcion: datos.descripcion,
      monto: datos.monto,
      moneda: datos.moneda || "BS",
      modo_cobro: "REPARTO_DIRECTO",
      estado: "APROBADO",
      fecha_aprobacion: hoy
    });

    // Generar cuotas extraordinarias
    const cuotas = RepoCuotas.generarExtraordinarias(
      egreso.id,
      datos.condominioId,
      datos.monto,
      datos.descripcion,
      hoy,
      datos.fechaVencimiento
    );

    // Guardar el reparto
    RepoEgresos.generarReparto(egreso.id, datos.condominioId, datos.monto);

    return {
      exito: true,
      egreso: egreso,
      cuotasGeneradas: cuotas.length,
      mensaje: "Egreso registrado. " + cuotas.length + " cuota(s) extraordinaria(s) generada(s)."
    };
  },

  /**
   * Verifica si un egreso de reparto directo ya está cubierto.
   * Se llama cuando se concilian pagos.
   */
  verificarCubierto: function(egresoId) {
    const egreso = this._obtenerEgreso_(egresoId);
    if (egreso.modo_cobro !== "REPARTO_DIRECTO" && egreso.modo_cobro !== "MIXTO") return null;

    const detalles = sb.select("cuota_detalle",
      "egreso_id=eq." + egresoId + "&select=cuota_id");
    if (!detalles.length) return { cubierto: false, motivo: "Sin cuotas asociadas" };

    const cuotaIds = detalles.map(d => d.cuota_id).join(",");
    const cuotas = sb.select("cuotas",
      "id=in.(" + cuotaIds + ")&select=id,estado,monto_original,monto_pagado");

    const todasPagadas = cuotas.every(c => c.estado === "PAGADA");
    const totalCubierto = cuotas.reduce((s, c) => s + parseFloat(c.monto_pagado), 0);
    const totalEsperado = cuotas.reduce((s, c) => s + parseFloat(c.monto_original), 0);

    if (todasPagadas) {
      RepoEgresos.marcarCubierto(egresoId);
      return { cubierto: true, cuotas: cuotas.length, totalCubierto: totalCubierto };
    }

    return {
      cubierto: false,
      cuotas: cuotas.length,
      totalCubierto: totalCubierto,
      totalEsperado: totalEsperado,
      pendiente: Math.round((totalEsperado - totalCubierto) * 100) / 100
    };
  },

  // ============================================================
  // ANULAR (aplica a cualquier modo)
  // ============================================================
  anular: function(egresoId, motivo) {
    const egreso = this._obtenerEgreso_(egresoId);
    if (egreso.estado === "ANULADO") throw new Error("Ya estaba anulado");

    const condominioId = egreso.condominio_id;
    const monto = parseFloat(egreso.monto_final || egreso.monto);
    const periodo = RepoPeriodosFiscales.abiertoPorCondominio(condominioId);
    const hoy = new Date().toISOString().substring(0, 10);

    // Revertir fondos si ya se había pagado
    if (egreso.estado === "PAGADO") {
      if (egreso.modo_cobro === "FONDO_OPERATIVO") {
        RepoFondoOperativo.registrarEntrada({
          condominio_id: condominioId,
          periodo_fiscal_id: periodo ? periodo.id : null,
          fecha: hoy,
          monto: monto,
          origen_tipo: "AJUSTE",
          descripcion: "Reversión anulación: " + egreso.descripcion
        });
      }
      if (egreso.modo_cobro === "FONDO_RESERVA") {
        RepoFondoReserva.registrarEntrada({
          condominio_id: condominioId,
          periodo_fiscal_id: periodo ? periodo.id : null,
          fecha: hoy,
          moneda: egreso.moneda || "BS",
          monto: monto,
          origen_tipo: "AJUSTE",
          descripcion: "Reversión anulación: " + egreso.descripcion
        });
      }
    }

    // Anular cuotas asociadas (reparto directo)
    const detalles = sb.select("cuota_detalle",
      "egreso_id=eq." + egresoId + "&select=cuota_id");
    detalles.forEach(d => RepoCuotas.anular(d.cuota_id));

    RepoEgresos.anular(egresoId);

    return {
      exito: true,
      cuotasAnuladas: detalles.length,
      mensaje: "Egreso anulado." + (detalles.length ? " " + detalles.length + " cuota(s) anulada(s)." : "")
    };
  },

  // ============================================================
  // HELPERS PRIVADOS
  // ============================================================

  _obtenerEgreso_: function(egresoId) {
    const e = RepoEgresos.porId(egresoId);
    if (!e) throw new Error("Egreso no encontrado: " + egresoId);
    return e;
  },

  _validarFondoOperativo_: function(condominioId, monto) {
    const saldo = RepoFondoOperativo.saldo(condominioId);
    if (saldo < monto) {
      throw new Error("Fondo operativo insuficiente. Disponible: Bs " + saldo + ". Requerido: Bs " + monto);
    }

    const params = RepoParametrosCondominio.porCondominio(condominioId);
    const pctTope = params ? parseFloat(params.tope_egreso_fondo_ope) : 70;
    const topeMonto = Math.round(saldo * (pctTope / 100) * 100) / 100;

    if (monto > topeMonto) {
      throw new Error(
        "Supera el tope del " + pctTope + "% del fondo operativo (máx: Bs " + topeMonto + "). " +
        "Se requiere aprobación extraordinaria."
      );
    }
  }

};

// ============================================================
// TEST — ServicioEgresos
// ============================================================
function testServicioEgresos() {
  Logger.log("=== TEST ServicioEgresos ===");

  const nombreTest = "Test Servicio Egresos";

    // Limpieza previa
  (function limpiar() {
    const prev = RepoCondominios.porNombre(nombreTest);
    if (!prev) return;
    const condId = prev.id;
    const edfs = sb.select("edificios", "condominio_id=eq." + condId);
    const edfIds = edfs.map(e => e.id);
    let inmIds = [];
    edfIds.forEach(eid => {
      sb.select("inmuebles", "edificio_id=eq." + eid).forEach(i => inmIds.push(i.id));
    });

    inmIds.forEach(iid => {
      // Pagos y sus aplicaciones
      const pagos = sb.select("pagos", "inmueble_id=eq." + iid);
      pagos.forEach(p => sb.delete("aplicaciones_pago", "pago_id=eq." + p.id));
      sb.delete("pagos", "inmueble_id=eq." + iid);

      // Saldos a favor
      sb.delete("saldos_favor", "inmueble_id=eq." + iid);

      // Cuotas: primero las dependencias
      const cuotas = sb.select("cuotas", "inmueble_id=eq." + iid);
      cuotas.forEach(c => {
        sb.delete("cuota_detalle", "cuota_id=eq." + c.id);
        sb.delete("aplicaciones_pago", "cuota_id=eq." + c.id);
        sb.delete("intereses_mora", "cuota_id=eq." + c.id);
      });
      sb.delete("cuotas", "inmueble_id=eq." + iid);
    });

    sb.delete("movimientos_fondo_operativo", "condominio_id=eq." + condId);
    sb.delete("movimientos_fondo_reserva", "condominio_id=eq." + condId);

    // Egresos: primero el reparto
    const egresos = sb.select("egresos", "condominio_id=eq." + condId);
    egresos.forEach(e => {
      sb.delete("egreso_reparto", "egreso_id=eq." + e.id);
    });
    sb.delete("egresos", "condominio_id=eq." + condId);

    sb.delete("categorias_gasto", "condominio_id=eq." + condId);
    sb.delete("parametros_condominio", "condominio_id=eq." + condId);
    sb.delete("parametros_fondo_reserva", "condominio_id=eq." + condId);
    sb.delete("periodo_fiscal", "condominio_id=eq." + condId);

    inmIds.forEach(iid => sb.delete("inmuebles", "id=eq." + iid));
    edfIds.forEach(eid => sb.delete("edificios", "id=eq." + eid));
    sb.delete("condominios", "id=eq." + condId);
  })();

  // ----------------------------------------------------------
  // SETUP
  // ----------------------------------------------------------
  Logger.log("\n--- Setup ---");
  const cond = RepoCondominios.crear({ nombre: nombreTest, email: "test@egr.com" });
  const edf = RepoEdificios.crear({ condominio_id: cond.id, nombre: "Edf Test", orden: 1 });
  const inm1 = RepoInmuebles.crear({ edificio_id: edf.id, codigo: "1-A", alicuota: 5.0 });
  const inm2 = RepoInmuebles.crear({ edificio_id: edf.id, codigo: "1-B", alicuota: 3.0 });
  const inm3 = RepoInmuebles.crear({ edificio_id: edf.id, codigo: "1-C", alicuota: 2.0 });

  const per = RepoPeriodosFiscales.crear({
    condominio_id: cond.id, anio: 2026,
    desde: "2026-01-01", hasta: "2026-12-31", estado: "ABIERTO"
  });
  RepoParametrosCondominio.crearConDefaults(cond.id);
  RepoParametrosFondoReserva.crearConDefaults(cond.id);

  const catOper = RepoCategoriasGasto.crear({
    condominio_id: cond.id, nombre: "Limpieza", modo_cobro: "FONDO_OPERATIVO"
  });
  const catRes = RepoCategoriasGasto.crear({
    condominio_id: cond.id, nombre: "Reparación mayor", modo_cobro: "FONDO_RESERVA"
  });
  const catRep = RepoCategoriasGasto.crear({
    condominio_id: cond.id, nombre: "Pintura fachada", modo_cobro: "REPARTO_DIRECTO"
  });

  // Cargar fondos
  RepoFondoOperativo.registrarEntrada({
    condominio_id: cond.id, periodo_fiscal_id: per.id,
    fecha: "2026-10-01", monto: 10000,
    origen_tipo: "AJUSTE", descripcion: "Carga inicial"
  });
  RepoFondoReserva.registrarEntrada({
    condominio_id: cond.id, periodo_fiscal_id: per.id,
    fecha: "2026-10-01", moneda: "BS", monto: 5000,
    origen_tipo: "AJUSTE", descripcion: "Carga inicial"
  });
  Logger.log("Fondo operativo: Bs " + RepoFondoOperativo.saldo(cond.id));
  Logger.log("Fondo reserva:   Bs " + RepoFondoReserva.saldo(cond.id).bs);

  // ----------------------------------------------------------
  // FLUJO 1 — EGRESO OPERATIVO (1 paso)
  // ----------------------------------------------------------
  Logger.log("\n--- FLUJO 1: Egreso OPERATIVO ---");

    const r1 = ServicioEgresos.registrarOperativo({
    condominioId: cond.id,
    categoriaId: catOper.id,
    fecha: "2026-10-15",
    descripcion: "Limpieza octubre",
    monto: 2000,
    archivoVoucherId: "00000000-0000-0000-0000-000000000001",
    referencia: "EGR-OPE-001"
  });

  Logger.log("Estado: " + r1.egreso.estado + " (esperado: PAGADO)");
  Logger.log("Fondo operativo: Bs " + RepoFondoOperativo.saldo(cond.id) + " (esperado: 8000)");

  // ----------------------------------------------------------
  // FLUJO 2 — EGRESO DE RESERVA (6 pasos)
  // ----------------------------------------------------------
  Logger.log("\n--- FLUJO 2: Egreso de RESERVA ---");

  // Paso 1: Registrar proyecto
  const r2a = ServicioEgresos.registrarProyecto({
    condominioId: cond.id,
    categoriaId: catRes.id,
    descripcion: "Cambio de ascensor",
    montoEstimado: 1000
  });
  Logger.log("1. Estado: " + r2a.egreso.estado + " (esperado: BORRADOR)");

  // Paso 2: Presentar a asamblea
  const r2b = ServicioEgresos.presentarAsamblea(r2a.egreso.id, "2026-10-20");
  Logger.log("2. Estado: " + r2b.egreso.estado + " (esperado: EN_ASAMBLEA)");

  // Paso 3: Aprobar
  const r2c = ServicioEgresos.aprobarProyecto(r2a.egreso.id, 1000);
  Logger.log("3. Estado: " + r2c.egreso.estado + " (esperado: APROBADO)");

  // Paso 4: Iniciar ejecución
  const r2d = ServicioEgresos.iniciarEjecucion(r2a.egreso.id);
  Logger.log("4. Estado: " + r2d.egreso.estado + " (esperado: EN_EJECUCION)");

  // Paso 5: Validar
  const r2e = ServicioEgresos.validarObra(r2a.egreso.id, {
    observaciones: "Instalación verificada, funciona correctamente"
  });
  Logger.log("5. Estado: " + r2e.egreso.estado + " (esperado: VALIDADO)");

  // Paso 6: Pagar
  const r2f = ServicioEgresos.pagarProyecto(r2a.egreso.id, {
    fechaPago: "2026-11-01",
    archivoVoucherId: "00000000-0000-0000-0000-000000000002"
  });
  Logger.log("6. Estado: " + r2f.egreso.estado + " (esperado: PAGADO)");
  Logger.log("Fondo reserva: Bs " + RepoFondoReserva.saldo(cond.id).bs + " (esperado: 4000)");

  // ----------------------------------------------------------
  // FLUJO 3 — REPARTO DIRECTO (genera cuotas)
  // ----------------------------------------------------------
  Logger.log("\n--- FLUJO 3: REPARTO DIRECTO ---");
  const r3 = ServicioEgresos.generarRepartoDirecto({
    condominioId: cond.id,
    categoriaId: catRep.id,
    descripcion: "Pintura fachada",
    monto: 10000,
    fechaVencimiento: "2026-12-15"
  });
  Logger.log("Estado egreso: " + r3.egreso.estado + " (esperado: APROBADO)");
  Logger.log("Cuotas generadas: " + r3.cuotasGeneradas + " (esperado: 3)");
  Logger.log("Fondo operativo (sin cambio): Bs " + RepoFondoOperativo.saldo(cond.id));

  // Ver las cuotas generadas (buscar por tipo, no por periodo)
  const cuotasExtr = sb.select("cuotas",
    "tipo=eq.EXTRAORDINARIA&inmueble_id=in.(" + inm1.id + "," + inm2.id + "," + inm3.id + ")" +
    "&select=*,inmueble:inmueble_id(codigo,alicuota)");
  Logger.log("Cuotas extraordinarias (" + cuotasExtr.length + "):");
  cuotasExtr.forEach(c => {
    Logger.log("  " + c.inmueble.codigo + " (" + c.inmueble.alicuota + "%) → Bs " + c.monto_original);
  });

  // ----------------------------------------------------------
  // VALIDACIÓN DE TOPE
  // ----------------------------------------------------------
  Logger.log("\n--- Validación de tope ---");
   try {
    ServicioEgresos.registrarOperativo({
      condominioId: cond.id,
      categoriaId: catOper.id,
      fecha: "2026-11-15",
      descripcion: "Gasto que supera el tope",
      monto: 7000,  // < 8000 (saldo OK) pero > 5600 (tope 70%) → debe rechazar por tope
      archivoVoucherId: "00000000-0000-0000-0000-000000000003"
    });
    Logger.log("ERROR: no debería haber pasado");
  } catch (e) {
    Logger.log("Correctamente rechazado: " + e.message);
  }

  // ----------------------------------------------------------
  // LIMPIEZA
  // ----------------------------------------------------------
  Logger.log("\n--- Limpieza ---");
  RepoCondominios.eliminar(cond.id);
  Logger.log("Test finalizado");

  Logger.log("\n=== TEST FINALIZADO ===");
}