// ============================================================
// REPOSITORIOS — MOVIMIENTOS
// Pagos, aplicaciones, saldos a favor, egresos, reparto,
// movimientos bancarios.
//
// Nota: los repos solo tocan sus tablas. La orquestación
// (crear movimiento de fondo al pagar) la hace el servicio.
// ============================================================

// ------------------------------------------------------------
// PAGOS
// ------------------------------------------------------------
const RepoPagos = {

  // ----------------------------------------------------------
  // CONSULTAS
  // ----------------------------------------------------------

  porId: function(id) {
    const res = sb.select("pagos", "id=eq." + id);
    return res && res.length ? res[0] : null;
  },

   porReferencia: function(condominioId, referencia) {
    const res = sb.select("pagos",
      "referencia=eq." + encodeURIComponent(referencia));
    return res && res.length ? res[0] : null;
  },

  listarPorInmueble: function(inmuebleId, filtros) {
    filtros = filtros || {};
    let q = "inmueble_id=eq." + inmuebleId + "&order=fecha_pago.desc";
    if (filtros.estado) q += "&estado=eq." + filtros.estado;
    if (filtros.desde) q += "&fecha_pago=gte." + filtros.desde;
    if (filtros.hasta) q += "&fecha_pago=lte." + filtros.hasta;
    return sb.select("pagos", q);
  },

  listarPorCondominio: function(condominioId, filtros) {
    filtros = filtros || {};
    let q = "select=*,inmueble:inmueble_id!inner(id,codigo,edificio_id,edificio:edificio_id!inner(nombre,condominio_id))" +
            "&inmueble.edificio.condominio_id=eq." + condominioId +
            "&order=fecha_pago.desc";
    if (filtros.estado) q += "&estado=eq." + filtros.estado;
    if (filtros.desde) q += "&fecha_pago=gte." + filtros.desde;
    if (filtros.hasta) q += "&fecha_pago=lte." + filtros.hasta;
    return sb.select("pagos", q);
  },

  /**
   * Lista pagos sin aplicar (registrados pero sin cuota asignada).
   */
  sinAplicarPorCondominio: function(condominioId) {
    return this.listarPorCondominio(condominioId, { estado: "REGISTRADO" });
  },

  /**
   * Verifica si una referencia ya existe en el condominio.
   */
  referenciaExiste: function(condominioId, referencia) {
    const p = this.porReferencia(condominioId, referencia);
    return !!p;
  },

  // ----------------------------------------------------------
  // CREACIÓN
  // ----------------------------------------------------------

  crear: function(datos) {
    // Asegurar monto_bs calculado si no viene
    if (!datos.monto_bs && datos.monto) {
      if (datos.moneda === "USD" && datos.tasa_bcv) {
        datos.monto_bs = Math.round(datos.monto * datos.tasa_bcv * 100) / 100;
      } else {
        datos.monto_bs = datos.monto;
      }
    }
    const res = sb.insert("pagos", datos);
    return res && res.length ? res[0] : null;
  },

  // ----------------------------------------------------------
  // ACTUALIZACIÓN
  // ----------------------------------------------------------

  actualizar: function(id, cambios) {
    const res = sb.update("pagos", "id=eq." + id, cambios);
    return res && res.length ? res[0] : null;
  },

  /**
   * Anula un pago (soft delete).
   */
  anular: function(id) {
    return this.actualizar(id, { estado: "ANULADO" });
  },

  /**
   * Marca el pago como aplicado (ya cubre cuotas).
   */
  marcarAplicado: function(id) {
    return this.actualizar(id, { estado: "APLICADO" });
  },

  /**
   * Marca el pago como conciliado con el banco.
   */
  marcarConciliado: function(id) {
    return this.actualizar(id, { estado: "CONCILIADO" });
  },

  // ----------------------------------------------------------
  // APLICACIONES (aplicar pago a cuotas)
  // ----------------------------------------------------------

  listarAplicaciones: function(pagoId) {
    return sb.select("aplicaciones_pago",
      "pago_id=eq." + pagoId +
      "&select=*,cuota:cuota_id(id,concepto,monto_original,monto_pagado,estado)");
  },

  /**
   * Aplica un pago a cuotas específicas (override manual).
   * @param {string} pagoId
   * @param {Array<{cuotaId, monto}>} aplicaciones
   */
  aplicarManual: function(pagoId, aplicaciones) {
    if (!aplicaciones || !aplicaciones.length) return [];

    const filas = aplicaciones.map(a => ({
      pago_id: pagoId,
      cuota_id: a.cuotaId,
      monto_aplicado: a.monto
    }));

    // 1. Insertar aplicaciones
    sb.insert("aplicaciones_pago", filas);

    // 2. Actualizar cada cuota
    aplicaciones.forEach(a => {
      RepoCuotas.aplicarPago(a.cuotaId, a.monto);
    });

    // 3. Marcar el pago como aplicado
    this.marcarAplicado(pagoId);

    return filas;
  },

  /**
   * Aplica un pago automáticamente a las cuotas más antiguas (FIFO).
   * Se detiene cuando se agota el monto del pago.
   * Si sobra, devuelve el remanente para crear saldo a favor.
   *
   * @param {string} pagoId
   * @param {string} inmuebleId
   * @param {number} montoBsDisponible
   * @return {{aplicadas: Array, sobrante: number}}
   */
  aplicarFIFO: function(pagoId, inmuebleId, montoBsDisponible) {
    const cuotasPendientes = RepoCuotas.pendientesPorInmueble(inmuebleId);
    let restante = parseFloat(montoBsDisponible);
    const aplicadas = [];

    for (const cuota of cuotasPendientes) {
      if (restante <= 0.001) break;

      const saldoCuota = parseFloat(cuota.saldo);
      const aAplicar = Math.min(restante, saldoCuota);

      aplicadas.push({
        pago_id: pagoId,
        cuota_id: cuota.id,
        monto_aplicado: Math.round(aAplicar * 100) / 100
      });

      restante = Math.round((restante - aAplicar) * 100) / 100;
    }

    if (aplicadas.length) {
      sb.insert("aplicaciones_pago", aplicadas);
      aplicadas.forEach(a => {
        RepoCuotas.aplicarPago(a.cuota_id, a.monto_aplicado);
      });
      this.marcarAplicado(pagoId);
    }

    return { aplicadas: aplicadas, sobrante: restante };
  }
};

// ------------------------------------------------------------
// SALDOS A FAVOR
// ------------------------------------------------------------
const RepoSaldosFavor = {

  porId: function(id) {
    const res = sb.select("saldos_favor", "id=eq." + id);
    return res && res.length ? res[0] : null;
  },

  disponiblesPorInmueble: function(inmuebleId) {
    return sb.select("saldos_favor",
      "inmueble_id=eq." + inmuebleId +
      "&estado=eq.DISPONIBLE&order=created_at.asc");
  },

  /**
   * Suma el saldo a favor disponible de un inmueble.
   */
  totalDisponible: function(inmuebleId) {
    const lista = this.disponiblesPorInmueble(inmuebleId);
    return lista.reduce((s, x) => s + parseFloat(x.monto), 0);
  },

  crear: function(datos) {
    const res = sb.insert("saldos_favor", datos);
    return res && res.length ? res[0] : null;
  },

  actualizar: function(id, cambios) {
    const res = sb.update("saldos_favor", "id=eq." + id, cambios);
    return res && res.length ? res[0] : null;
  },

  aplicar: function(id) {
    return this.actualizar(id, { estado: "APLICADO" });
  },

  anular: function(id) {
    return this.actualizar(id, { estado: "ANULADO" });
  }
};

// ------------------------------------------------------------
// EGRESOS
// ------------------------------------------------------------
const RepoEgresos = {

  porId: function(id) {
    const res = sb.select("egresos", "id=eq." + id);
    return res && res.length ? res[0] : null;
  },

  listarPorCondominio: function(condominioId, filtros) {
    filtros = filtros || {};
    let q = "condominio_id=eq." + condominioId + "&order=fecha.desc";
    if (filtros.estado) q += "&estado=eq." + filtros.estado;
    if (filtros.modoCobro) q += "&modo_cobro=eq." + filtros.modoCobro;
    if (filtros.categoriaId) q += "&categoria_id=eq." + filtros.categoriaId;
    if (filtros.periodoFiscalId) q += "&periodo_fiscal_id=eq." + filtros.periodoFiscalId;
    if (filtros.desde) q += "&fecha=gte." + filtros.desde;
    if (filtros.hasta) q += "&fecha=lte." + filtros.hasta;
    return sb.select("egresos", q);
  },

  listarPorPeriodo: function(periodoFiscalId, filtros) {
    filtros = filtros || {};
    let q = "periodo_fiscal_id=eq." + periodoFiscalId + "&order=fecha.desc";
    if (filtros.estado) q += "&estado=eq." + filtros.estado;
    if (filtros.modoCobro) q += "&modo_cobro=eq." + filtros.modoCobro;
    if (filtros.categoriaId) q += "&categoria_id=eq." + filtros.categoriaId;
    if (filtros.desde) q += "&fecha=gte." + filtros.desde;
    if (filtros.hasta) q += "&fecha=lte." + filtros.hasta;
    return sb.select("egresos", q);
  },

  porReferencia: function(condominioId, referencia) {
    const res = sb.select("egresos",
      "condominio_id=eq." + condominioId +
      "&referencia=eq." + encodeURIComponent(referencia));
    return res && res.length ? res[0] : null;
  },

  /**
   * Lista egresos con su categoría expandida.
   */
  listarConCategoria: function(condominioId, filtros) {
    filtros = filtros || {};
    let q = "select=*,categoria:categoria_id(id,nombre,modo_cobro)" +
            "&condominio_id=eq." + condominioId +
            "&order=fecha.desc";
    if (filtros.estado) q += "&estado=eq." + filtros.estado;
    if (filtros.desde) q += "&fecha=gte." + filtros.desde;
    if (filtros.hasta) q += "&fecha=lte." + filtros.hasta;
    return sb.select("egresos", q);
  },

  // ----------------------------------------------------------
  // CREACIÓN
  // ----------------------------------------------------------

  crear: function(datos) {
    // Calcular monto_usd_referencia si aplica
    if (datos.moneda === "BS" && datos.tasa_bcv && !datos.monto_usd_referencia) {
      datos.monto_usd_referencia = Math.round((datos.monto / datos.tasa_bcv) * 100) / 100;
    }
    const res = sb.insert("egresos", datos);
    return res && res.length ? res[0] : null;
  },

  // ----------------------------------------------------------
  // ACTUALIZACIÓN
  // ----------------------------------------------------------

  actualizar: function(id, cambios) {
    const res = sb.update("egresos", "id=eq." + id, cambios);
    return res && res.length ? res[0] : null;
  },

  aprobar: function(id) {
    return this.actualizar(id, { estado: "APROBADO" });
  },

  marcarPagado: function(id) {
    return this.actualizar(id, { estado: "PAGADO" });
  },

  marcarCubierto: function(id) {
    return this.actualizar(id, { estado: "CUBIERTO" });
  },

  anular: function(id) {
    return this.actualizar(id, { estado: "ANULADO" });
  },

  // ----------------------------------------------------------
  // REPARTO DIRECTO
  // ----------------------------------------------------------

  /**
   * Genera el reparto de un egreso entre los inmuebles activos.
   * NO crea las cuotas (eso lo hace RepoCuotas.generarExtraordinarias).
   * Solo guarda el detalle de cuánto le toca a cada uno.
   */
  generarReparto: function(egresoId, condominioId, montoTotal) {
    const inmuebles = RepoInmuebles.listarConEdificio(condominioId);
    if (!inmuebles.length) throw new Error("No hay inmuebles activos.");

    const repartos = inmuebles.map(inm => {
      const alicuota = parseFloat(inm.alicuota);
      return {
        egreso_id: egresoId,
        inmueble_id: inm.id,
        monto: Math.round(montoTotal * (alicuota / 100) * 100) / 100,
        porcentaje: alicuota
      };
    });

    sb.insert("egreso_reparto", repartos);
    return repartos;
  },

  listarReparto: function(egresoId) {
    return sb.select("egreso_reparto",
      "egreso_id=eq." + egresoId +
      "&select=*,inmueble:inmueble_id(id,codigo)");
  }
};

// ------------------------------------------------------------
// MOVIMIENTOS BANCARIOS
// ------------------------------------------------------------
const RepoMovimientosBanco = {

  porId: function(id) {
    const res = sb.select("movimientos_banco", "id=eq." + id);
    return res && res.length ? res[0] : null;
  },

  porReferencia: function(condominioId, referencia) {
    const res = sb.select("movimientos_banco",
      "condominio_id=eq." + condominioId +
      "&referencia=eq." + encodeURIComponent(referencia));
    return res && res.length ? res[0] : null;
  },

  listarPorCondominio: function(condominioId, filtros) {
    filtros = filtros || {};
    let q = "condominio_id=eq." + condominioId + "&order=fecha.desc";
    if (filtros.estado) q += "&estado_conciliacion=eq." + filtros.estado;
    if (filtros.desde) q += "&fecha=gte." + filtros.desde;
    if (filtros.hasta) q += "&fecha=lte." + filtros.hasta;
    return sb.select("movimientos_banco", q);
  },

  listarHuerfanos: function(condominioId) {
    return this.listarPorCondominio(condominioId, { estado: "HUERFANO" });
  },

  listarPendientes: function(condominioId) {
    return this.listarPorCondominio(condominioId, { estado: "PENDIENTE" });
  },

  /**
   * Inserta un lote de movimientos bancarios (del extracto).
   * Detecta duplicados por referencia (la constraint unique lo bloquea).
   */
  crearLote: function(movimientos) {
    if (!movimientos || !movimientos.length) return [];
    return sb.insert("movimientos_banco", movimientos);
  },

  crear: function(datos) {
    const res = sb.insert("movimientos_banco", datos);
    return res && res.length ? res[0] : null;
  },

  actualizar: function(id, cambios) {
    const res = sb.update("movimientos_banco", "id=eq." + id, cambios);
    return res && res.length ? res[0] : null;
  },

  /**
   * Concilia un movimiento con un pago.
   */
  conciliarConPago: function(movimientoId, pagoId) {
    return this.actualizar(movimientoId, {
      pago_id: pagoId,
      estado_conciliacion: "CONCILIADO"
    });
  },

  /**
   * Concilia un movimiento con un egreso.
   */
  conciliarConEgreso: function(movimientoId, egresoId) {
    return this.actualizar(movimientoId, {
      egreso_id: egresoId,
      estado_conciliacion: "CONCILIADO"
    });
  },

  marcarHuerfano: function(movimientoId, nota) {
    return this.actualizar(movimientoId, {
      estado_conciliacion: "HUERFANO",
      nota: nota || null
    });
  },

  marcarIgnorado: function(movimientoId, nota) {
    return this.actualizar(movimientoId, {
      estado_conciliacion: "IGNORADO",
      nota: nota || null
    });
  }
};

// ============================================================
// TEST — Repos de Movimientos
// ============================================================
function testReposMovimientos() {
  Logger.log("=== TEST Repos de Movimientos ===");

  const nombreTest = "Test Movimientos Repo";
  const previo = RepoCondominios.porNombre(nombreTest);
  if (previo) RepoCondominios.eliminar(previo.id);

  // ============================================================
  // SETUP
  // ============================================================
  Logger.log("\n--- Setup ---");
  const cond = RepoCondominios.crear({
    nombre: nombreTest,
    email: "test@mov.com"
  });
  const edf = RepoEdificios.crear({
    condominio_id: cond.id,
    nombre: "Edificio A",
    orden: 1
  });
  const inm = RepoInmuebles.crear({
    edificio_id: edf.id,
    codigo: "1-A",
    alicuota: 5.0,
    metros: 80
  });
  const per = RepoPeriodosFiscales.crear({
    condominio_id: cond.id,
    anio: 2026,
    desde: "2026-01-01",
    hasta: "2026-12-31",
    estado: "ABIERTO"
  });
  const cat = RepoCategoriasGasto.crear({
    condominio_id: cond.id,
    nombre: "Limpieza",
    modo_cobro: "FONDO_OPERATIVO"
  });

  Logger.log("Setup OK");

  // ============================================================
  // 1. CREAR 3 CUOTAS ORDINARIAS (una por mes)
  // ============================================================
  Logger.log("\n--- 1. Cuotas de prueba ---");
  const cuota1 = RepoCuotas.crear({
    inmueble_id: inm.id,
    periodo_fiscal_id: per.id,
    tipo: "ORDINARIA",
    concepto: "Cuota Enero",
    monto_original: 500,
    fecha_emision: "2026-01-01",
    fecha_vencimiento: "2026-01-15"
  });
  const cuota2 = RepoCuotas.crear({
    inmueble_id: inm.id,
    periodo_fiscal_id: per.id,
    tipo: "ORDINARIA",
    concepto: "Cuota Febrero",
    monto_original: 500,
    fecha_emision: "2026-02-01",
    fecha_vencimiento: "2026-02-15"
  });
  const cuota3 = RepoCuotas.crear({
    inmueble_id: inm.id,
    periodo_fiscal_id: per.id,
    tipo: "ORDINARIA",
    concepto: "Cuota Marzo",
    monto_original: 500,
    fecha_emision: "2026-03-01",
    fecha_vencimiento: "2026-03-15"
  });
  Logger.log("3 cuotas de Bs 500 creadas");

  // ============================================================
  // 2. REGISTRAR PAGO Y APLICAR FIFO
  // ============================================================
  Logger.log("\n--- 2. Pago + aplicar FIFO ---");
  const pago = RepoPagos.crear({
    inmueble_id: inm.id,
    fecha_pago: "2026-03-20",
    monto: 1200,
    moneda: "BS",
    monto_bs: 1200,
    referencia: "REF-TEST-001",
    banco: "Banesco",
    estado: "REGISTRADO"
  });
  Logger.log("Pago creado: Bs " + pago.monto_bs);

  const fifo = RepoPagos.aplicarFIFO(pago.id, inm.id, pago.monto_bs);
  Logger.log("Aplicadas: " + fifo.aplicadas.length + " cuotas");
  fifo.aplicadas.forEach(a => Logger.log("  Cuota " + a.cuota_id.substring(0,8) + " → Bs " + a.monto_aplicado));
  Logger.log("Sobrante: Bs " + fifo.sobrante);

  // ============================================================
  // 3. VERIFICAR ESTADO DE CUOTAS
  // ============================================================
  Logger.log("\n--- 3. Verificar cuotas ---");
  const c1 = RepoCuotas.porId(cuota1.id);
  const c2 = RepoCuotas.porId(cuota2.id);
  const c3 = RepoCuotas.porId(cuota3.id);
  Logger.log("Cuota1: " + c1.estado + " (saldo " + c1.saldo + ")");
  Logger.log("Cuota2: " + c2.estado + " (saldo " + c2.saldo + ")");
  Logger.log("Cuota3: " + c3.estado + " (saldo " + c3.saldo + ")");

  // ============================================================
  // 4. PAGO 2 → APLICAR MANUAL
  // ============================================================
  Logger.log("\n--- 4. Pago + aplicar manual ---");
  const pago2 = RepoPagos.crear({
    inmueble_id: inm.id,
    fecha_pago: "2026-04-01",
    monto: 300,
    moneda: "BS",
    monto_bs: 300,
    referencia: "REF-TEST-002",
    banco: "Banesco",
    estado: "REGISTRADO"
  });
  RepoPagos.aplicarManual(pago2.id, [
    { cuotaId: cuota3.id, monto: 200 }
  ]);
  const c3Final = RepoCuotas.porId(cuota3.id);
  Logger.log("Cuota3 final: " + c3Final.estado + " (saldo " + c3Final.saldo + ")");

  // ============================================================
  // 5. SALDO A FAVOR
  // ============================================================
  Logger.log("\n--- 5. Saldo a favor ---");
  const sf = RepoSaldosFavor.crear({
    inmueble_id: inm.id,
    monto: 100,
    origen_pago_id: pago2.id,
    estado: "DISPONIBLE"
  });
  Logger.log("Saldo creado: Bs " + sf.monto);
  Logger.log("Total disponible: Bs " + RepoSaldosFavor.totalDisponible(inm.id));

  // ============================================================
  // 6. EGRESO DE FONDO OPERATIVO
  // ============================================================
  Logger.log("\n--- 6. Egreso fondo operativo ---");
  const egr = RepoEgresos.crear({
    condominio_id: cond.id,
    periodo_fiscal_id: per.id,
    fecha: "2026-04-15",
    categoria_id: cat.id,
    descripcion: "Limpieza abril",
    monto: 200,
    modo_cobro: "FONDO_OPERATIVO",
    referencia: "EGR-001",
    estado: "BORRADOR"
  });
  Logger.log("Egreso creado: Bs " + egr.monto + " (" + egr.estado + ")");
  const aprobado = RepoEgresos.aprobar(egr.id);
  Logger.log("Después de aprobar: " + aprobado.estado);

  // ============================================================
  // 7. EGRESO DE REPARTO DIRECTO
  // ============================================================
  Logger.log("\n--- 7. Egreso reparto directo ---");
  const catRep = RepoCategoriasGasto.crear({
    condominio_id: cond.id,
    nombre: "Reparación",
    modo_cobro: "REPARTO_DIRECTO"
  });
  const egrRep = RepoEgresos.crear({
    condominio_id: cond.id,
    fecha: "2026-04-20",
    categoria_id: catRep.id,
    descripcion: "Reparación ascensor",
    monto: 10000,
    modo_cobro: "REPARTO_DIRECTO",
    referencia: "EGR-002",
    estado: "APROBADO"
  });
  const reparto = RepoEgresos.generarReparto(egrRep.id, cond.id, egrRep.monto);
  Logger.log("Reparto generado: " + reparto.length + " inmuebles");
  reparto.forEach(r => Logger.log("  " + r.porcentaje + "% → Bs " + r.monto));

  // ============================================================
  // 8. MOVIMIENTO BANCARIO
  // ============================================================
  Logger.log("\n--- 8. Movimiento banco ---");
  const mov = RepoMovimientosBanco.crear({
    condominio_id: cond.id,
    banco: "Banesco",
    fecha: "2026-03-20",
    referencia: "REF-TEST-001",
    descripcion: "Pago Móvil Condominio Apto 1-A",
    monto: 1200,
    estado_conciliacion: "PENDIENTE"
  });
  Logger.log("Movimiento creado: " + mov.referencia);
  const conc = RepoMovimientosBanco.conciliarConPago(mov.id, pago.id);
  Logger.log("Conciliado: " + conc.estado_conciliacion);

  // ============================================================
  // LIMPIEZA
  // ============================================================
  Logger.log("\n--- Limpieza ---");
  RepoCondominios.eliminar(cond.id);
  Logger.log("Test finalizado");

  Logger.log("\n=== TEST FINALIZADO ===");
}


function debugPorReferencia() {
  Logger.log("=== DEBUG porReferencia ===");
  
  // Buscar cualquier pago existente
  const pagos = sb.select("pagos", "limit=5");
  Logger.log("Pagos existentes: " + pagos.length);
  pagos.forEach(p => Logger.log("  - " + p.referencia));
  
  if (pagos.length === 0) {
    Logger.log("No hay pagos. Corre primero el test de conciliación.");
    return;
  }
  
  // Probar la función con la primera referencia
  const ref = pagos[0].referencia;
  const encontrado = RepoPagos.porReferencia(null, ref);
  Logger.log("Buscando '" + ref + "': " + (encontrado ? "ENCONTRADO" : "NO ENCONTRADO"));
}