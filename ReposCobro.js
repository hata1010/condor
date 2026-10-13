// ============================================================
// REPOSITORIOS — COBRO
// Cuotas (ordinarias y extraordinarias) + intereses de mora.
// El corazón del sistema de obligaciones de pago.
// ============================================================

// ------------------------------------------------------------
// CUOTAS
// ------------------------------------------------------------
const RepoCuotas = {

  // ----------------------------------------------------------
  // CONSULTAS
  // ----------------------------------------------------------

  porId: function(id) {
    const res = sb.select("cuotas", "id=eq." + id);
    return res && res.length ? res[0] : null;
  },

  /**
   * Lista cuotas de un inmueble. Filtros opcionales: estado, tipo, periodo.
   */
  listarPorInmueble: function(inmuebleId, filtros) {
    filtros = filtros || {};
    let q = "inmueble_id=eq." + inmuebleId + "&order=fecha_emision.desc";
    if (filtros.estado) q += "&estado=eq." + filtros.estado;
    if (filtros.tipo) q += "&tipo=eq." + filtros.tipo;
    if (filtros.periodoFiscalId) q += "&periodo_fiscal_id=eq." + filtros.periodoFiscalId;
    return sb.select("cuotas", q);
  },

  /**
   * Lista cuotas de un periodo fiscal completo (para el admin).
   */
  listarPorPeriodo: function(periodoFiscalId, filtros) {
    filtros = filtros || {};
    let q = "periodo_fiscal_id=eq." + periodoFiscalId + "&order=fecha_vencimiento.asc";
    if (filtros.estado) q += "&estado=eq." + filtros.estado;
    if (filtros.tipo) q += "&tipo=eq." + filtros.tipo;
    return sb.select("cuotas", q);
  },

  /**
   * Cuotas pendientes o parciales de un inmueble.
   */
  pendientesPorInmueble: function(inmuebleId) {
    return sb.select("cuotas",
      "inmueble_id=eq." + inmuebleId +
      "&estado=in.(PENDIENTE,PARCIAL,VENCIDA)" +
      "&order=fecha_vencimiento.asc");
  },

  /**
   * Cuotas vencidas de un condominio (con datos del inmueble).
   * Útil para el módulo de morosidad.
   */
  vencidasPorCondominio: function(condominioId) {
    return sb.select("cuotas",
      "select=*,inmueble:inmueble_id(id,codigo,edificio_id,edificio:edificio_id(nombre))" +
      "&estado=in.(PENDIENTE,PARCIAL,VENCIDA)" +
      "&inmueble.edificio.condominio_id=eq." + condominioId +
      "&order=fecha_vencimiento.asc");
  },

  /**
   * Cuenta cuotas por estado en un periodo.
   */
  contarPorEstado: function(periodoFiscalId) {
    const todas = sb.select("cuotas",
      "periodo_fiscal_id=eq." + periodoFiscalId + "&select=estado");
    const conteo = { PENDIENTE: 0, PARCIAL: 0, PAGADA: 0, VENCIDA: 0, ANULADA: 0 };
    todas.forEach(c => { conteo[c.estado] = (conteo[c.estado] || 0) + 1; });
    return conteo;
  },

  // ----------------------------------------------------------
  // CREACIÓN
  // ----------------------------------------------------------

  crear: function(datos) {
    // Asegurar que saldo esté calculado
    if (datos.saldo === undefined) {
      datos.saldo = datos.monto_original;
    }
    const res = sb.insert("cuotas", datos);
    return res && res.length ? res[0] : null;
  },

  /**
   * Crea varias cuotas de una sola vez (bulk insert).
   * Útil para generar cuotas ordinarias del mes.
   */
  crearLote: function(cuotas) {
    if (!cuotas || !cuotas.length) return [];
    // Asegurar saldo calculado en cada una
    cuotas.forEach(c => {
      if (c.saldo === undefined) c.saldo = c.monto_original;
    });
    return sb.insert("cuotas", cuotas);
  },

  /**
   * Genera las cuotas ORDINARIAS del mes para todos los inmuebles activos
   * de un condominio en un periodo fiscal.
   *
   * @param {string} condominioId
   * @param {string} periodoFiscalId
   * @param {number} montoCuotaBase - monto por alícuota del 100%
   * @param {string} concepto - ej: "Cuota Mayo 2026"
   * @param {string} fechaEmision - YYYY-MM-DD
   * @param {string} fechaVencimiento - YYYY-MM-DD
   */
  generarOrdinarias: function(condominioId, periodoFiscalId, montoCuotaBase, concepto, fechaEmision, fechaVencimiento) {
    // 1. Obtener todos los inmuebles activos del condominio
    const inmuebles = RepoInmuebles.listarConEdificio(condominioId);
    if (!inmuebles.length) {
      throw new Error("No hay inmuebles activos en el condominio.");
    }

    // 2. Armar las cuotas
    const nuevas = inmuebles.map(inm => {
      const monto = Math.round(montoCuotaBase * (parseFloat(inm.alicuota) / 100) * 100) / 100;
      return {
        inmueble_id: inm.id,
        periodo_fiscal_id: periodoFiscalId,
        tipo: "ORDINARIA",
        concepto: concepto,
        monto_original: monto,
        monto_pagado: 0,
        saldo: monto,
        fecha_emision: fechaEmision,
        fecha_vencimiento: fechaVencimiento,
        estado: "PENDIENTE"
      };
    });

    // 3. Insertar en lote
    return this.crearLote(nuevas);
  },

  /**
   * Genera cuotas EXTRAORDINARIAS por reparto directo de un egreso.
   *
   * @param {string} egresoId
   * @param {string} condominioId
   * @param {number} montoTotal - monto del egreso
   * @param {string} concepto - ej: "Reparación ascensor"
   * @param {string} fechaEmision
   * @param {string} fechaVencimiento
   */
  generarExtraordinarias: function(egresoId, condominioId, montoTotal, concepto, fechaEmision, fechaVencimiento) {
    const inmuebles = RepoInmuebles.listarConEdificio(condominioId);
    if (!inmuebles.length) {
      throw new Error("No hay inmuebles activos en el condominio.");
    }

    const nuevas = inmuebles.map(inm => {
      const monto = Math.round(montoTotal * (parseFloat(inm.alicuota) / 100) * 100) / 100;
      return {
        inmueble_id: inm.id,
        periodo_fiscal_id: null,
        tipo: "EXTRAORDINARIA",
        concepto: concepto,
        monto_original: monto,
        monto_pagado: 0,
        saldo: monto,
        fecha_emision: fechaEmision,
        fecha_vencimiento: fechaVencimiento,
        estado: "PENDIENTE"
      };
    });

    // Insertar cuotas
    const cuotasCreadas = this.crearLote(nuevas);

    // Insertar cuota_detalle vinculando cada cuota al egreso
    if (egresoId && cuotasCreadas && cuotasCreadas.length) {
      const detalles = cuotasCreadas.map(c => ({
        cuota_id: c.id,
        egreso_id: egresoId,
        monto: c.monto_original
      }));
      sb.insert("cuota_detalle", detalles);
    }

    return cuotasCreadas;
  },

  // ----------------------------------------------------------
  // ACTUALIZACIÓN
  // ----------------------------------------------------------

  actualizar: function(id, cambios) {
    const res = sb.update("cuotas", "id=eq." + id, cambios);
    return res && res.length ? res[0] : null;
  },

  /**
   * Aplica un monto al pago de una cuota.
   * Actualiza monto_pagado, saldo y estado automáticamente.
   *
   * @param {string} cuotaId
   * @param {number} montoAplicado
   */
 aplicarPago: function(cuotaId, montoAplicado) {
  const cuota = this.porId(cuotaId);
  if (!cuota) throw new Error("Cuota no encontrada: " + cuotaId);

  const nuevoPagado = Math.round((parseFloat(cuota.monto_pagado) + montoAplicado) * 100) / 100;
  const nuevoSaldo = Math.round((parseFloat(cuota.monto_original) - nuevoPagado) * 100) / 100;

  let nuevoEstado;
  if (nuevoPagado <= 0.01) {
    // Sin pagos → vuelve a PENDIENTE (o VENCIDA si ya pasó la fecha)
    const vencida = cuota.fecha_vencimiento &&
                    new Date(cuota.fecha_vencimiento) < new Date();
    nuevoEstado = vencida ? "VENCIDA" : "PENDIENTE";
  } else if (nuevoSaldo <= 0.01) {
    nuevoEstado = "PAGADA";
  } else {
    // Pagos parciales
    nuevoEstado = cuota.estado === "VENCIDA" ? "VENCIDA" : "PARCIAL";
  }

  return this.actualizar(cuotaId, {
    monto_pagado: Math.max(0, nuevoPagado),
    saldo: Math.max(0, nuevoSaldo),
    estado: nuevoEstado
  });
},

  /**
   * Marca una cuota como VENCIDA (para el proceso de actualización).
   */
  marcarVencida: function(cuotaId) {
    return this.actualizar(cuotaId, { estado: "VENCIDA" });
  },

  /**
   * Anula una cuota (no se borra, se anula).
   */
  anular: function(cuotaId) {
    return this.actualizar(cuotaId, { estado: "ANULADA" });
  },

  /**
   * Reactiva una cuota anulada.
   */
  reactivar: function(cuotaId) {
    const cuota = this.porId(cuotaId);
    if (!cuota) throw new Error("Cuota no encontrada.");
    // Recalcular estado según montos
    const pagado = parseFloat(cuota.monto_pagado);
    const total = parseFloat(cuota.monto_original);
    let estado;
    if (pagado >= total) estado = "PAGADA";
    else if (pagado > 0) estado = "PARCIAL";
    else estado = "PENDIENTE";
    return this.actualizar(cuotaId, { estado: estado });
  }
};

// ------------------------------------------------------------
// INTERESES DE MORA
// ------------------------------------------------------------
const RepoInteresesMora = {

  listarPorCuota: function(cuotaId) {
    return sb.select("intereses_mora",
      "cuota_id=eq." + cuotaId + "&order=fecha_calculo.desc");
  },

  porId: function(id) {
    const res = sb.select("intereses_mora", "id=eq." + id);
    return res && res.length ? res[0] : null;
  },

  crear: function(datos) {
    const res = sb.insert("intereses_mora", datos);
    return res && res.length ? res[0] : null;
  },

  /**
   * Suma los intereses acumulados de una cuota.
   */
  totalPorCuota: function(cuotaId) {
    const lista = this.listarPorCuota(cuotaId);
    return lista.reduce((s, i) => s + parseFloat(i.monto), 0);
  },

  /**
   * Suma los intereses acumulados de un inmueble (todas sus cuotas).
   */
  totalPorInmueble: function(inmuebleId) {
    const cuotas = sb.select("cuotas",
      "inmueble_id=eq." + inmuebleId + "&select=id");
    if (!cuotas.length) return 0;
    const ids = cuotas.map(c => c.id).join(",");
    const intereses = sb.select("intereses_mora",
      "cuota_id=in.(" + ids + ")&select=monto");
    return intereses.reduce((s, i) => s + parseFloat(i.monto), 0);
  },

  /**
   * Calcula el interés de mora dado un monto, tasa mensual y días de mora.
   * Fórmula: monto × (tasa / 100) × (días / 30)
   *
   * @param {number} monto - monto original de la cuota
   * @param {number} tasaMensual - ej: 3 (%)
   * @param {number} diasMora - días transcurridos desde vencimiento
   * @param {boolean} congelar - si true, limita días a 90 (3 meses)
   */
  calcular: function(monto, tasaMensual, diasMora, congelar) {
    if (diasMora <= 0) return 0;
    const diasEfectivos = congelar ? Math.min(diasMora, 90) : diasMora;
    const interes = parseFloat(monto) * (tasaMensual / 100) * (diasEfectivos / 30);
    return Math.round(interes * 100) / 100;
  },

  /**
   * Registra el interés del día para una cuota vencida.
   * (Se llama desde el servicio de mora, no desde el repo).
   */
  registrar: function(cuotaId, monto, tasa, dias) {
    return this.crear({
      cuota_id: cuotaId,
      fecha_calculo: new Date().toISOString().substring(0, 10),
      monto: monto,
      tasa_aplicada: tasa,
      dias_mora: dias
    });
  }
};

// ============================================================
// TEST — Repos de Cobro
// ============================================================
function testReposCobro() {
  Logger.log("=== TEST Repos de Cobro ===");

  const nombreTest = "Test Cobro Repo";

  // Limpieza previa
  const previo = RepoCondominios.porNombre(nombreTest);
  if (previo) RepoCondominios.eliminar(previo.id);

  // ------------------------------------------------------------
  // SETUP: condominio + edificio + 3 inmuebles + periodo + cuota
  // ------------------------------------------------------------
  Logger.log("\n--- Setup ---");
  const cond = RepoCondominios.crear({
    nombre: nombreTest,
    email: "test@cobro.com"
  });
  Logger.log("Condominio: " + cond.id);

  const edf = RepoEdificios.crear({
    condominio_id: cond.id,
    nombre: "Edificio Único",
    orden: 1
  });

  // 3 inmuebles con alícuotas: 5%, 3%, 2% (suman 10%)
  const alicuotas = [
    { codigo: "1-A", alicuota: 5.0 },
    { codigo: "1-B", alicuota: 3.0 },
    { codigo: "1-C", alicuota: 2.0 }
  ];
  const inmuebles = alicuotas.map(a => {
    return RepoInmuebles.crear({
      edificio_id: edf.id,
      codigo: a.codigo,
      alicuota: a.alicuota,
      metros: 80
    });
  });
  Logger.log("Inmuebles creados: " + inmuebles.length);

  const per = RepoPeriodosFiscales.crear({
    condominio_id: cond.id,
    anio: 2026,
    desde: "2026-01-01",
    hasta: "2026-12-31",
    estado: "ABIERTO"
  });

  // ------------------------------------------------------------
  // 1. GENERAR CUOTAS ORDINARIAS
  // ------------------------------------------------------------
  Logger.log("\n--- 1. Cuotas Ordinarias ---");
  // Cuota base: Bs 70 por alícuota del 100%
  // Inmueble 5% → 70 × 0.05 = Bs 3.50
  // Inmueble 3% → 70 × 0.03 = Bs 2.10
  // Inmueble 2% → 70 × 0.02 = Bs 1.40
  const creadas = RepoCuotas.generarOrdinarias(
    cond.id,
    per.id,
    70, // monto base
    "Cuota Octubre 2026",
    "2026-10-01",
    "2026-10-15"
  );
  Logger.log("Cuotas creadas: " + creadas.length);
  creadas.forEach(c => {
    Logger.log("  Inmueble " + c.inmueble_id.substring(0,8) + " → Bs " + c.monto_original);
  });

  // ------------------------------------------------------------
  // 2. LISTAR
  // ------------------------------------------------------------
  Logger.log("\n--- 2. Listar por inmueble ---");
  const cuotasInm1 = RepoCuotas.listarPorInmueble(inmuebles[0].id);
  Logger.log("Inmueble 1-A: " + cuotasInm1.length + " cuota(s)");

  const pendientes = RepoCuotas.pendientesPorInmueble(inmuebles[0].id);
  Logger.log("Pendientes de 1-A: " + pendientes.length);

  // ------------------------------------------------------------
  // 3. CONTAR POR ESTADO
  // ------------------------------------------------------------
  Logger.log("\n--- 3. Contar por estado ---");
  const conteo = RepoCuotas.contarPorEstado(per.id);
  Logger.log("Pendientes: " + conteo.PENDIENTE);
  Logger.log("Pagadas:    " + conteo.PAGADA);
  Logger.log("Vencidas:   " + conteo.VENCIDA);

  // ------------------------------------------------------------
  // 4. APLICAR PAGO PARCIAL
  // ------------------------------------------------------------
  Logger.log("\n--- 4. Pago parcial ---");
  const cuota1A = cuotasInm1[0];
  Logger.log("Antes: pagado=" + cuota1A.monto_pagado + " saldo=" + cuota1A.saldo + " estado=" + cuota1A.estado);
  const actualizada = RepoCuotas.aplicarPago(cuota1A.id, 2.00);
  Logger.log("Después: pagado=" + actualizada.monto_pagado + " saldo=" + actualizada.saldo + " estado=" + actualizada.estado);

  // ------------------------------------------------------------
  // 5. APLICAR PAGO COMPLETO
  // ------------------------------------------------------------
  Logger.log("\n--- 5. Completar pago ---");
  const final = RepoCuotas.aplicarPago(cuota1A.id, actualizada.saldo);
  Logger.log("Estado final: " + final.estado + " (saldo Bs " + final.saldo + ")");

  // ------------------------------------------------------------
  // 6. CUOTAS EXTRAORDINARIAS
  // ------------------------------------------------------------
  Logger.log("\n--- 6. Cuotas Extraordinarias ---");
  // Simulamos un egreso de Bs 10.000 repartido por alícuota
  // Inmueble 5% → 10000 × 0.05 = 500
  // Inmueble 3% → 10000 × 0.03 = 300
  // Inmueble 2% → 10000 × 0.02 = 200
  const extr = RepoCuotas.generarExtraordinarias(
    null, // sin egreso asociado (para el test)
    cond.id,
    10000,
    "Reparación ascensor",
    "2026-10-01",
    "2026-11-01"
  );
  Logger.log("Extraordinarias: " + extr.length);
  extr.forEach(c => {
    Logger.log("  → Bs " + c.monto_original + " (alícuota del inmueble)");
  });

  // ------------------------------------------------------------
  // 7. MORA
  // ------------------------------------------------------------
  Logger.log("\n--- 7. Cálculo de mora ---");
  // Cuota de 500 con 3% mensual y 45 días de mora
  const interesCalc = RepoInteresesMora.calcular(500, 3.00, 45, false);
  Logger.log("Interés 45 días sobre Bs 500: Bs " + interesCalc);
  // Con congelamiento (máx 90 días)
  const interesCongelado = RepoInteresesMora.calcular(500, 3.00, 120, true);
  Logger.log("Interés 120 días (congelado a 90): Bs " + interesCongelado);

  // ------------------------------------------------------------
  // 8. REGISTRAR INTERÉS
  // ------------------------------------------------------------
  Logger.log("\n--- 8. Registrar interés ---");
  const cuotaExtr = extr[0];
  RepoInteresesMora.registrar(cuotaExtr.id, 15.00, 3.00, 45);
  const totalInteres = RepoInteresesMora.totalPorCuota(cuotaExtr.id);
  Logger.log("Interés acumulado: Bs " + totalInteres);
  const totalInmueble = RepoInteresesMora.totalPorInmueble(cuotaExtr.inmueble_id);
  Logger.log("Interés total del inmueble: Bs " + totalInmueble);

  // ------------------------------------------------------------
  // 9. ANULAR
  // ------------------------------------------------------------
  Logger.log("\n--- 9. Anular cuota ---");
  const anulada = RepoCuotas.anular(extr[1].id);
  Logger.log("Estado: " + anulada.estado);
  const reactivada = RepoCuotas.reactivar(extr[1].id);
  Logger.log("Después de reactivar: " + reactivada.estado);

  // ------------------------------------------------------------
  // LIMPIEZA
  // ------------------------------------------------------------
  Logger.log("\n--- Limpieza ---");
  RepoCondominios.eliminar(cond.id);
  Logger.log("Test finalizado");

  Logger.log("\n=== TEST FINALIZADO ===");
}