// ============================================================
// SERVICIO — CUOTAS
// Genera las cuotas ordinarias del mes para todos los inmuebles
// activos, y aplica automáticamente los abonos disponibles.
// ============================================================

const ServicioCuotas = {

  // ============================================================
  // GENERAR CUOTAS DEL MES
  // ============================================================
  /**
   * @param {string} condominioId
   * @param {Object} opciones
   *   - concepto: "Cuota Octubre 2026" (obligatorio)
   *   - fechaEmision: "2026-10-01" (default hoy)
   *   - fechaVencimiento: "2026-10-15" (obligatorio)
   *   - periodoFiscalId: uuid (default: periodo abierto)
   *   - montoBaseOverride: number (opcional, para forzar monto)
   * @return {Object} resumen
   */
  generarCuotasDelMes: function(condominioId, opciones) {
    if (!condominioId) throw new Error("Falta condominioId");
    if (!opciones || !opciones.concepto) throw new Error("Falta concepto");
    if (!opciones.fechaVencimiento) throw new Error("Falta fechaVencimiento");

    const fechaEmision = opciones.fechaEmision || new Date().toISOString().substring(0, 10);
    const concepto = opciones.concepto;

    // 1. Periodo fiscal
    let periodo;
    if (opciones.periodoFiscalId) {
      periodo = RepoPeriodosFiscales.porId(opciones.periodoFiscalId);
    } else {
      periodo = RepoPeriodosFiscales.abiertoPorCondominio(condominioId);
    }
    if (!periodo) throw new Error("No hay periodo fiscal abierto.");

    // 2. Cuota base vigente
    let montoBase;
    if (opciones.montoBaseOverride) {
      montoBase = parseFloat(opciones.montoBaseOverride);
    } else {
      const cb = RepoCuotasBase.vigente(condominioId);
      if (!cb) throw new Error("No hay cuota base vigente para el condominio.");
      montoBase = parseFloat(cb.monto);
    }

    // 3. Inmuebles activos del condominio
    const inmuebles = RepoInmuebles.listarConEdificio(condominioId);
    if (!inmuebles.length) throw new Error("No hay inmuebles activos.");

    // 4. Verificar cuáles ya tienen la cuota de este concepto
    const existentes = sb.select("cuotas",
      "periodo_fiscal_id=eq." + periodo.id +
      "&tipo=eq.ORDINARIA" +
      "&concepto=eq." + encodeURIComponent(concepto) +
      "&select=inmueble_id");
    const inmueblesConCuota = new Set(existentes.map(e => e.inmueble_id));

    // 5. Armar las cuotas nuevas (solo para inmuebles que no la tienen)
    const nuevas = [];
    inmuebles.forEach(inm => {
      if (inmueblesConCuota.has(inm.id)) return; // ya existe

      const monto = Math.round(montoBase * (parseFloat(inm.alicuota) / 100) * 100) / 100;
      nuevas.push({
        inmueble_id: inm.id,
        periodo_fiscal_id: periodo.id,
        tipo: "ORDINARIA",
        concepto: concepto,
        monto_original: monto,
        monto_pagado: 0,
        saldo: monto,
        fecha_emision: fechaEmision,
        fecha_vencimiento: opciones.fechaVencimiento,
        estado: "PENDIENTE"
      });
    });

    if (!nuevas.length) {
      return {
        exito: true,
        creadas: 0,
        omitidas: inmueblesConCuota.size,
        montoTotal: 0,
        mensaje: "Todas las cuotas ya existían para este concepto."
      };
    }

    // 6. Insertar en lote
    const cuotasCreadas = RepoCuotas.crearLote(nuevas);

    // 7. Aplicar abonos disponibles automáticamente
    let totalAplicado = 0;
    let cuotasPagadas = 0;
    let cuotasParciales = 0;

    cuotasCreadas.forEach(c => {
      const resultado = this.aplicarAbonosACuota(c.id);
      totalAplicado += resultado.aplicado;
      if (resultado.estadoFinal === "PAGADA") cuotasPagadas++;
      else if (resultado.estadoFinal === "PARCIAL") cuotasParciales++;
    });

    const montoTotal = cuotasCreadas.reduce((s, c) => s + parseFloat(c.monto_original), 0);

    return {
      exito: true,
      creadas: cuotasCreadas.length,
      omitidas: inmueblesConCuota.size,
      montoTotal: Math.round(montoTotal * 100) / 100,
      abonosAplicados: Math.round(totalAplicado * 100) / 100,
      cuotasPagadas: cuotasPagadas,
      cuotasParciales: cuotasParciales,
      mensaje: cuotasCreadas.length + " cuota(s) generada(s). " +
               (totalAplicado > 0 ? "Bs " + totalAplicado.toFixed(2) + " aplicados desde abonos." : "")
    };
  },

  // ============================================================
  // PREVISUALIZAR — sin crear nada
  // ============================================================
  previsualizar: function(condominioId, opciones) {
    if (!condominioId) throw new Error("Falta condominioId");
    if (!opciones || !opciones.concepto) throw new Error("Falta concepto");

    // Cuota base
    let montoBase;
    if (opciones.montoBaseOverride) {
      montoBase = parseFloat(opciones.montoBaseOverride);
    } else {
      const cb = RepoCuotasBase.vigente(condominioId);
      if (!cb) throw new Error("No hay cuota base vigente.");
      montoBase = parseFloat(cb.monto);
    }

    const inmuebles = RepoInmuebles.listarConEdificio(condominioId);
    if (!inmuebles.length) throw new Error("No hay inmuebles activos.");

    const detalle = inmuebles.map(inm => {
      const monto = Math.round(montoBase * (parseFloat(inm.alicuota) / 100) * 100) / 100;
      const abonoDisponible = RepoSaldosFavor.totalDisponible(inm.id);
      const cubiertoPorAbono = Math.min(abonoDisponible, monto);

      return {
        inmuebleId: inm.id,
        codigo: inm.codigo,
        alicuota: parseFloat(inm.alicuota),
        monto: monto,
        abonoDisponible: abonoDisponible,
        cubiertoPorAbono: cubiertoPorAbono,
        pendientePago: Math.round((monto - cubiertoPorAbono) * 100) / 100
      };
    });

    const montoTotal = detalle.reduce((s, d) => s + d.monto, 0);
    const totalCubierto = detalle.reduce((s, d) => s + d.cubiertoPorAbono, 0);

    return {
      exito: true,
      concepto: opciones.concepto,
      montoBase: montoBase,
      totalInmuebles: detalle.length,
      montoTotal: Math.round(montoTotal * 100) / 100,
      totalCubiertoPorAbonos: Math.round(totalCubierto * 100) / 100,
      pendienteCobro: Math.round((montoTotal - totalCubierto) * 100) / 100,
      detalle: detalle
    };
  },

  // ============================================================
  // APLICAR ABONOS DISPONIBLES A UNA CUOTA (FIFO)
  // ============================================================
  aplicarAbonosACuota: function(cuotaId) {
    const cuota = RepoCuotas.porId(cuotaId);
    if (!cuota) throw new Error("Cuota no encontrada");
    if (cuota.estado === "PAGADA" || cuota.estado === "ANULADA") {
      return { aplicado: 0, estadoFinal: cuota.estado, cuotas: 0 };
    }

    // Abonos disponibles del inmueble, ordenados por fecha asc (más viejos primero)
    const abonos = RepoSaldosFavor.disponiblesPorInmueble(cuota.inmueble_id);
    if (!abonos.length) {
      return { aplicado: 0, estadoFinal: cuota.estado, cuotas: 0 };
    }

    let totalAplicado = 0;
    let abonosConsumidos = 0;

    for (const abono of abonos) {
      const cuotaActual = RepoCuotas.porId(cuotaId);
      const saldoCuota = parseFloat(cuotaActual.saldo);
      if (saldoCuota <= 0.01) break; // ya está cubierta

      const montoAbono = parseFloat(abono.monto);
      const aAplicar = Math.round(Math.min(saldoCuota, montoAbono) * 100) / 100;

      // Aplicar el monto a la cuota
      RepoCuotas.aplicarPago(cuotaId, aAplicar);
      totalAplicado += aAplicar;

      // Reducir el abono
      const restanteAbono = Math.round((montoAbono - aAplicar) * 100) / 100;
      if (restanteAbono <= 0.01) {
        RepoSaldosFavor.aplicar(abono.id);
        abonosConsumidos++;
      } else {
        RepoSaldosFavor.actualizar(abono.id, { monto: restanteAbono });
      }
    }

    const cuotaFinal = RepoCuotas.porId(cuotaId);
    return {
      aplicado: Math.round(totalAplicado * 100) / 100,
      estadoFinal: cuotaFinal.estado,
      abonosConsumidos: abonosConsumidos,
      saldoRestante: parseFloat(cuotaFinal.saldo)
    };
  },

  // ============================================================
  // ANULAR TODAS LAS CUOTAS DE UN CONCEPTO
  // ============================================================
  anularCuotasDelMes: function(condominioId, concepto) {
    if (!condominioId) throw new Error("Falta condominioId");
    if (!concepto) throw new Error("Falta concepto");

    // Buscar cuotas del concepto
    const cuotas = sb.select("cuotas",
      "concepto=eq." + encodeURIComponent(concepto) +
      "&tipo=eq.ORDINARIA" +
      "&select=id,estado,inmueble_id");

    // Filtrar solo las del condominio
    const edfs = sb.select("edificios", "condominio_id=eq." + condominioId);
    const edfIds = new Set(edfs.map(e => e.id));
    const inms = [];
    edfIds.forEach(eid => {
      sb.select("inmuebles", "edificio_id=eq." + eid).forEach(i => inms.push(i.id));
    });
    const inmIdsSet = new Set(inms);

    const cuotasDelCondominio = cuotas.filter(c => inmIdsSet.has(c.inmueble_id));

    let anuladas = 0;
    cuotasDelCondominio.forEach(c => {
      if (c.estado === "ANULADA") return;
      RepoCuotas.anular(c.id);
      anuladas++;
    });

    return {
      exito: true,
      anuladas: anuladas,
      mensaje: anuladas + " cuota(s) anulada(s)."
    };
  }

};

// ============================================================
// TEST — ServicioCuotas
// ============================================================
function testServicioCuotas() {
  Logger.log("=== TEST ServicioCuotas ===");

  const nombreTest = "Test Servicio Cuotas";

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
      const pagos = sb.select("pagos", "inmueble_id=eq." + iid);
      pagos.forEach(p => sb.delete("aplicaciones_pago", "pago_id=eq." + p.id));
      sb.delete("pagos", "inmueble_id=eq." + iid);
      sb.delete("saldos_favor", "inmueble_id=eq." + iid);
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
    const egresos = sb.select("egresos", "condominio_id=eq." + condId);
    egresos.forEach(e => sb.delete("egreso_reparto", "egreso_id=eq." + e.id));
    sb.delete("egresos", "condominio_id=eq." + condId);
    sb.delete("categorias_gasto", "condominio_id=eq." + condId);
    sb.delete("parametros_condominio", "condominio_id=eq." + condId);
    sb.delete("parametros_fondo_reserva", "condominio_id=eq." + condId);
    sb.delete("cuotas_base", "condominio_id=eq." + condId);
    sb.delete("periodo_fiscal", "condominio_id=eq." + condId);
    inmIds.forEach(iid => sb.delete("inmuebles", "id=eq." + iid));
    edfIds.forEach(eid => sb.delete("edificios", "id=eq." + eid));
    sb.delete("condominios", "id=eq." + condId);
  })();

  // ----------------------------------------------------------
  // SETUP
  // ----------------------------------------------------------
  Logger.log("\n--- Setup ---");
  const cond = RepoCondominios.crear({ nombre: nombreTest, email: "test@cuotas.com" });
  const edf = RepoEdificios.crear({ condominio_id: cond.id, nombre: "Edf Test", orden: 1 });
  const inm1 = RepoInmuebles.crear({ edificio_id: edf.id, codigo: "1-A", alicuota: 5.0 });
  const inm2 = RepoInmuebles.crear({ edificio_id: edf.id, codigo: "1-B", alicuota: 3.0 });
  const inm3 = RepoInmuebles.crear({ edificio_id: edf.id, codigo: "1-C", alicuota: 2.0 });

  const per = RepoPeriodosFiscales.crear({
    condominio_id: cond.id, anio: 2026,
    desde: "2026-01-01", hasta: "2026-12-31", estado: "ABIERTO"
  });

  // Cuota base: Bs 70 (así inmueble con alícuota 5% paga Bs 3.50)
  RepoCuotasBase.crear({
    condominio_id: cond.id,
    monto: 70,
    monto_reserva: 7,
    vigente_desde: "2026-01-01",
    estado: "ACTIVO"
  });
  Logger.log("Cuota base creada: Bs 70");

  // ----------------------------------------------------------
  // 1. PREVISUALIZAR
  // ----------------------------------------------------------
  Logger.log("\n--- 1. Previsualizar ---");
  const prev = ServicioCuotas.previsualizar(cond.id, {
    concepto: "Cuota Octubre 2026"
  });
  Logger.log("Monto base: Bs " + prev.montoBase);
  Logger.log("Total inmuebles: " + prev.totalInmuebles);
  Logger.log("Monto total a cobrar: Bs " + prev.montoTotal);
  prev.detalle.forEach(d => {
    Logger.log("  " + d.codigo + " (" + d.alicuota + "%) → Bs " + d.monto);
  });

  // ----------------------------------------------------------
  // 2. GENERAR CUOTAS
  // ----------------------------------------------------------
  Logger.log("\n--- 2. Generar cuotas ---");
  const gen = ServicioCuotas.generarCuotasDelMes(cond.id, {
    concepto: "Cuota Octubre 2026",
    fechaEmision: "2026-10-01",
    fechaVencimiento: "2026-10-15"
  });
  Logger.log("Cuotas creadas: " + gen.creadas);
  Logger.log("Monto total: Bs " + gen.montoTotal);
  Logger.log("Abonos aplicados: Bs " + gen.abonosAplicados);
  Logger.log("Pagadas: " + gen.cuotasPagadas + ", Parciales: " + gen.cuotasParciales);

  // ----------------------------------------------------------
  // 3. VERIFICAR CUOTAS CREADAS
  // ----------------------------------------------------------
  Logger.log("\n--- 3. Verificar cuotas ---");
  const cuotas = RepoCuotas.pendientesPorInmueble(inm1.id);
  Logger.log("Cuotas pendientes 1-A: " + cuotas.length);
  cuotas.forEach(c => {
    Logger.log("  " + c.concepto + ": Bs " + c.monto_original + " (" + c.estado + ")");
  });

  // ----------------------------------------------------------
  // 4. INTENTAR REGENERAR (no debe duplicar)
  // ----------------------------------------------------------
  Logger.log("\n--- 4. Regenerar (no debe duplicar) ---");
  const regen = ServicioCuotas.generarCuotasDelMes(cond.id, {
    concepto: "Cuota Octubre 2026",
    fechaEmision: "2026-10-01",
    fechaVencimiento: "2026-10-15"
  });
  Logger.log("Cuotas creadas: " + regen.creadas + " (esperado: 0)");
  Logger.log("Omitidas: " + regen.omitidas + " (esperado: 3)");

  // ----------------------------------------------------------
  // 5. CREAR ABONO A FAVOR Y APLICAR
  // ----------------------------------------------------------
  Logger.log("\n--- 5. Crear abono y aplicar ---");
  // Simular que 1-A tiene un abono de Bs 2.00
  const pagoDummy = RepoPagos.crear({
    inmueble_id: inm1.id,
    fecha_pago: "2026-10-05",
    monto: 2.00, moneda: "BS", monto_bs: 2.00,
    referencia: "REF-ABONO-001", estado: "CONCILIADO"
  });
  const abono = RepoSaldosFavor.crear({
    inmueble_id: inm1.id,
    monto: 2.00,
    origen_pago_id: pagoDummy.id,
    estado: "DISPONIBLE"
  });
  Logger.log("Abono creado: Bs " + abono.monto);

  // Buscar la cuota de 1-A
  const cuota1A = sb.select("cuotas",
    "inmueble_id=eq." + inm1.id + "&concepto=eq." + encodeURIComponent("Cuota Octubre 2026"))[0];
  Logger.log("Cuota 1-A antes: " + cuota1A.estado + " (saldo Bs " + cuota1A.saldo + ")");

  // Aplicar abono
  const apl = ServicioCuotas.aplicarAbonosACuota(cuota1A.id);
  Logger.log("Aplicado: Bs " + apl.aplicado);
  Logger.log("Estado final: " + apl.estadoFinal);
  Logger.log("Saldo restante: Bs " + apl.saldoRestante);

  // ----------------------------------------------------------
  // 6. GENERAR CUOTA DE NOVIEMBRE (debe aplicar abono remanente si hay)
  // ----------------------------------------------------------
  Logger.log("\n--- 6. Generar Noviembre ---");
  const gen2 = ServicioCuotas.generarCuotasDelMes(cond.id, {
    concepto: "Cuota Noviembre 2026",
    fechaEmision: "2026-11-01",
    fechaVencimiento: "2026-11-15"
  });
  Logger.log("Cuotas creadas: " + gen2.creadas);

  // ----------------------------------------------------------
  // 7. ANULAR CUOTAS
  // ----------------------------------------------------------
  Logger.log("\n--- 7. Anular cuotas de Octubre ---");
  const anul = ServicioCuotas.anularCuotasDelMes(cond.id, "Cuota Octubre 2026");
  Logger.log("Anuladas: " + anul.anuladas + " (esperado: 3)");

  // Verificar
  const cuotasOct = sb.select("cuotas",
    "concepto=eq." + encodeURIComponent("Cuota Octubre 2026") +
    "&select=estado");
  const anuladas = cuotasOct.filter(c => c.estado === "ANULADA").length;
  Logger.log("Verificación: " + anuladas + " cuotas en estado ANULADA");

  // ----------------------------------------------------------
  // LIMPIEZA
  // ----------------------------------------------------------
  Logger.log("\n--- Limpieza ---");
  RepoCondominios.eliminar(cond.id);
  Logger.log("Test finalizado");

  Logger.log("\n=== TEST FINALIZADO ===");
}