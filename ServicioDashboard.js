// ============================================================
// SERVICIO — DASHBOARD
// Consolida información para el portal.
// NO ejecuta operaciones. Solo lee y agrega.
// ============================================================

const ServicioDashboard = {

  // ============================================================
  // DASHBOARD DEL PROPIETARIO
  // ============================================================
  dashboardPropietario: function(inmuebleId) {
    if (!inmuebleId) throw new Error("Falta inmuebleId");

    const inm = RepoInmuebles.porId(inmuebleId);
    if (!inm) throw new Error("Inmueble no encontrado");

    const edfRes = sb.select("edificios", "id=eq." + inm.edificio_id);
    if (!edfRes || !edfRes.length) throw new Error("Edificio no encontrado");
    const edificio = edfRes[0];
    const condominioId = edificio.condominio_id;

    // Periodo fiscal activo
    const periodo = RepoPeriodosFiscales.abiertoPorCondominio(condominioId);

    // Cuota base vigente
    const cuotaBase = RepoCuotasBase.vigente(condominioId);

    // Todos los datos del inmueble (una sola pasada)
    const cuotas = RepoCuotas.listarPorInmueble(inmuebleId);
    const saldoFavor = RepoSaldosFavor.totalDisponible(inmuebleId);
    const estadoMora = ServicioMora.estadoCuentaConMora(inmuebleId);

    // Cuotas del periodo actual
    const cuotasPeriodo = cuotas.filter(c =>
      c.periodo_fiscal_id === (periodo ? periodo.id : null) &&
      c.tipo === "ORDINARIA" &&
      c.estado !== "ANULADA"
    );

    // Estados
    const pagadas = cuotasPeriodo.filter(c => c.estado === "PAGADA").length;
    const pendientes = cuotasPeriodo.filter(c =>
      c.estado === "PENDIENTE" || c.estado === "PARCIAL"
    ).length;
    const vencidas = cuotasPeriodo.filter(c => c.estado === "VENCIDA").length;

    // Saldo total
    const saldoTotal = cuotasPeriodo.reduce((s, c) => {
      if (c.estado === "PAGADA" || c.estado === "ANULADA") return s;
      return s + parseFloat(c.saldo);
    }, 0);

    // Últimos pagos
    const ultimosPagos = RepoPagos.listarPorInmueble(inmuebleId)
      .sort((a, b) => new Date(b.fecha_pago) - new Date(a.fecha_pago))
      .slice(0, 5)
      .map(p => ({
        fecha: p.fecha_pago,
        monto: parseFloat(p.monto_bs),
        referencia: p.referencia,
        estado: p.estado,
        mes: p.mes_aplicado || null,
        anio: p.anio_aplicado || null
      }));

    // Estado general
    let estadoGeneral;
    if (vencidas > 0) estadoGeneral = "EN_MORA";
    else if (pendientes > 0) estadoGeneral = "AL_DIA";
    else estadoGeneral = "SOLVENTE";

    return {
      inmueble: {
        id: inm.id,
        codigo: inm.codigo,
        alicuota: parseFloat(inm.alicuota),
        edificio: edificio.nombre
      },
      periodo: periodo ? periodo.anio : null,
      cuotaMensual: cuotaBase ? parseFloat(cuotaBase.monto) * (parseFloat(inm.alicuota) / 100) : 0,
      estadoGeneral: estadoGeneral,

      resumen: {
        mesesPagados: pagadas,
        mesesPendientes: pendientes,
        mesesVencidos: vencidas,
        saldoPendiente: Math.round(saldoTotal * 100) / 100,
        interesMora: estadoMora.totalInteres,
        saldoConMora: estadoMora.totalDeuda,
        abonoDisponible: saldoFavor
      },

      cuotas: cuotasPeriodo.map(c => ({
        id: c.id,
        concepto: c.concepto,
        monto: parseFloat(c.monto_original),
        pagado: parseFloat(c.monto_pagado),
        saldo: parseFloat(c.saldo),
        estado: c.estado,
        fechaVencimiento: c.fecha_vencimiento
      })),

      ultimosPagos: ultimosPagos
    };
  },

  // ============================================================
  // DASHBOARD DEL ADMIN
  // ============================================================
  dashboardAdmin: function(condominioId) {
    if (!condominioId) throw new Error("Falta condominioId");

    const periodo = RepoPeriodosFiscales.abiertoPorCondominio(condominioId);

    // ----------------------------------------------------------
    // 1. Inmuebles y propietarios
    // ----------------------------------------------------------
    const inmuebles = RepoInmuebles.listarConEdificio(condominioId);
    const totalInmuebles = inmuebles.length;

    // ----------------------------------------------------------
    // 2. Fondos
    // ----------------------------------------------------------
    const saldoOperativo = RepoFondoOperativo.saldo(condominioId);
    const saldoReserva = RepoFondoReserva.saldo(condominioId);

    // ----------------------------------------------------------
    // 3. Ingresos y egresos del periodo actual
    // ----------------------------------------------------------
    let ingresos = 0;
    let egresos = 0;
    let pagosMes = 0;

    if (periodo) {
      // Ingresos: pagos conciliados en el periodo
      const inmIds = inmuebles.map(i => i.id).join(",");
      const desde = this._fechaAString_(periodo.desde);
      const hasta = this._fechaAString_(periodo.hasta);

      const pagosCondominio = sb.select("pagos",
        "inmueble_id=in.(" + inmIds + ")" +
        "&estado=in.(CONCILIADO,APLICADO)" +
        "&fecha_pago=gte." + desde +
        "&fecha_pago=lte." + hasta);

      pagosCondominio.forEach(p => {
        ingresos += parseFloat(p.monto_bs);
      });
      pagosMes = pagosCondominio.length;

      // Egresos del periodo
      const egresosPeriodo = RepoEgresos.listarPorCondominio(condominioId, {
        estado: "PAGADO",
        periodoFiscalId: periodo.id
      });
      egresosPeriodo.forEach(e => {
        egresos += parseFloat(e.monto_final || e.monto);
      });
    }

    // ----------------------------------------------------------
    // 4. Al día vs en mora
    // ----------------------------------------------------------
    let alDia = 0;
    let enMora = 0;
    const deudores = [];

    inmuebles.forEach(inm => {
      const estado = ServicioMora.estadoCuentaConMora(inm.id);
      if (estado.totalDeuda > 0.01) {
        enMora++;
        deudores.push({
          inmuebleId: inm.id,
          codigo: inm.codigo,
          edificio: inm.edificio ? inm.edificio.nombre : null,
          deuda: estado.totalDeuda,
          saldo: estado.totalSaldo,
          interes: estado.totalInteres
        });
      } else {
        alDia++;
      }
    });

    deudores.sort((a, b) => b.deuda - a.deuda);

    // ----------------------------------------------------------
    // 5. Próximos vencimientos
    // ----------------------------------------------------------
    const proximosVencimientos = this._proximosVencimientos_(condominioId, 5);

    return {
      condominio: {
        id: condominioId
      },
      periodo: periodo ? periodo.anio : null,
      fechaCorte: new Date().toISOString().substring(0, 10),

      propietarios: {
        total: totalInmuebles,
        alDia: alDia,
        enMora: enMora,
        porcentajeAlDia: totalInmuebles > 0 ? Math.round((alDia / totalInmuebles) * 100) : 0
      },

      fondos: {
        operativo: saldoOperativo,
        reservaBs: saldoReserva.bs,
        reservaUsd: saldoReserva.usd,
        reservaEquivalenteBs: saldoReserva.bs_equivalente
      },

      periodoActual: {
        ingresos: Math.round(ingresos * 100) / 100,
        egresos: Math.round(egresos * 100) / 100,
        balance: Math.round((ingresos - egresos) * 100) / 100,
        pagosRecibidos: pagosMes
      },

      topDeudores: deudores.slice(0, 5),

      proximosVencimientos: proximosVencimientos,

      totales: {
        deudaTotal: Math.round(deudores.reduce((s, d) => s + d.deuda, 0) * 100) / 100
      }
    };
  },

  // ============================================================
  // DETALLE DEL INMUEBLE (vista completa)
  // ============================================================
  dashboardInmueble: function(inmuebleId) {
    const dashboard = this.dashboardPropietario(inmuebleId);
    const estadoMora = ServicioMora.estadoCuentaConMora(inmuebleId);
    const cuotasMora = ServicioMora.cuotasEnMora(inmuebleId);

    // Abonos
    const abonos = RepoSaldosFavor.disponiblesPorInmueble(inmuebleId);

    // Pagos completos
    const pagos = RepoPagos.listarPorInmueble(inmuebleId);

    return Object.assign({}, dashboard, {
      cuotasConMora: estadoMora.cuotas,
      abonos: abonos.map(a => ({
        id: a.id,
        monto: parseFloat(a.monto),
        fecha: a.created_at
      })),
      pagos: pagos.map(p => ({
        fecha: p.fecha_pago,
        monto: parseFloat(p.monto_bs),
        referencia: p.referencia,
        estado: p.estado,
        banco: p.banco
      }))
    });
  },

  // ============================================================
  // SALDO CONSOLIDADO (rápido)
  // ============================================================
  saldoConsolidado: function(inmuebleId) {
    const estadoMora = ServicioMora.estadoCuentaConMora(inmuebleId);
    const abono = RepoSaldosFavor.totalDisponible(inmuebleId);

    const deudaNeta = Math.max(0, estadoMora.totalDeuda - abono);

    return {
      saldoPendiente: estadoMora.totalSaldo,
      interesMora: estadoMora.totalInteres,
      deudaBruta: estadoMora.totalDeuda,
      abonoDisponible: abono,
      deudaNeta: Math.round(deudaNeta * 100) / 100,
      estaAlDia: deudaNeta <= 0.01
    };
  },

  // ============================================================
  // HELPERS PRIVADOS
  // ============================================================

  _proximosVencimientos_: function(condominioId, limite) {
    const inmuebles = RepoInmuebles.listarConEdificio(condominioId);
    if (!inmuebles.length) return [];

    const inmIds = inmuebles.map(i => i.id).join(",");
    const hoy = new Date().toISOString().substring(0, 10);

    const cuotas = sb.select("cuotas",
      "inmueble_id=in.(" + inmIds + ")" +
      "&estado=in.(PENDIENTE,PARCIAL)" +
      "&fecha_vencimiento=gte." + hoy +
      "&order=fecha_vencimiento.asc&limit=" + (limite || 5) +
      "&select=id,concepto,fecha_vencimiento,monto_original,saldo,inmueble_id");

    // Mapear nombre de inmueble
    const inmMap = {};
    inmuebles.forEach(i => { inmMap[i.id] = i.codigo; });

    return cuotas.map(c => ({
      cuotaId: c.id,
      inmueble: inmMap[c.inmueble_id] || "?",
      concepto: c.concepto,
      fechaVencimiento: c.fecha_vencimiento,
      monto: parseFloat(c.monto_original),
      saldo: parseFloat(c.saldo)
    }));
  },
    /**
   * Convierte un valor de fecha (Date o string ISO) a formato "YYYY-MM-DD".
   */
  _fechaAString_: function(valor) {
    if (!valor) return null;
    if (typeof valor === "string") {
      // Ya es string, tomar los primeros 10 caracteres
      return valor.substring(0, 10);
    }
    if (valor instanceof Date) {
      return valor.toISOString().substring(0, 10);
    }
    return String(valor).substring(0, 10);
  }

};


// ============================================================
// TEST — ServicioDashboard
// ============================================================
function testServicioDashboard() {
  Logger.log("=== TEST ServicioDashboard ===");

  const nombreTest = "Test Servicio Dashboard";

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

    sb.delete("movimientos_banco", "condominio_id=eq." + condId);
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
    sb.delete("auditoria", "condominio_id=eq." + condId);
    inmIds.forEach(iid => sb.delete("inmuebles", "id=eq." + iid));
    edfIds.forEach(eid => sb.delete("edificios", "id=eq." + eid));
    sb.delete("condominios", "id=eq." + condId);
  })();

  // ----------------------------------------------------------
  // SETUP
  // ----------------------------------------------------------
  Logger.log("\n--- Setup ---");
  const cond = RepoCondominios.crear({ nombre: nombreTest, email: "test@dash.com" });
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
  RepoCuotasBase.crear({
    condominio_id: cond.id, monto: 100, monto_reserva: 10,
    vigente_desde: "2026-01-01", estado: "ACTIVO"
  });

  Logger.log("Setup OK");

  // ----------------------------------------------------------
  // CREAR SITUACIONES DISTINTAS
  // ----------------------------------------------------------
  Logger.log("\n--- Creando situaciones ---");

  const hoy = new Date();
  const hace30 = new Date(hoy); hace30.setDate(hace30.getDate() - 30);
  const hace90 = new Date(hoy); hace90.setDate(hace90.getDate() - 90);
  const fmt = d => d.toISOString().substring(0, 10);

  // 1-A: Al día — 3 cuotas pagadas
  const a1 = RepoCuotas.crear({
    inmueble_id: inm1.id, periodo_fiscal_id: per.id, tipo: "ORDINARIA",
    concepto: "Cuota Oct", monto_original: 500,
    fecha_emision: "2026-10-01", fecha_vencimiento: "2026-10-15",
    monto_pagado: 500, saldo: 0, estado: "PAGADA"
  });
  const a2 = RepoCuotas.crear({
    inmueble_id: inm1.id, periodo_fiscal_id: per.id, tipo: "ORDINARIA",
    concepto: "Cuota Nov", monto_original: 500,
    fecha_emision: "2026-11-01", fecha_vencimiento: "2026-11-15",
    monto_pagado: 500, saldo: 0, estado: "PAGADA"
  });

  // 1-A también tiene un abono a favor
  const pagoAbono = RepoPagos.crear({
    inmueble_id: inm1.id,
    fecha_pago: "2026-11-01",
    monto: 200, moneda: "BS", monto_bs: 200,
    referencia: "REF-ABONO-DASH", estado: "CONCILIADO"
  });
  RepoSaldosFavor.crear({
    inmueble_id: inm1.id, monto: 200,
    origen_pago_id: pagoAbono.id, estado: "DISPONIBLE"
  });

  // 1-B: Con cuota pendiente
  const b1 = RepoCuotas.crear({
    inmueble_id: inm2.id, periodo_fiscal_id: per.id, tipo: "ORDINARIA",
    concepto: "Cuota Dic", monto_original: 300,
    fecha_emision: "2026-12-01", fecha_vencimiento: "2026-12-15",
    estado: "PENDIENTE"
  });

  // 1-C: Con cuota vencida (mora)
  const c1 = RepoCuotas.crear({
    inmueble_id: inm3.id, periodo_fiscal_id: per.id, tipo: "ORDINARIA",
    concepto: "Cuota Atrasada", monto_original: 200,
    fecha_emision: fmt(hace30), fecha_vencimiento: fmt(hace30),
    estado: "PENDIENTE"
  });

  // Cargar fondos para que el dashboard los muestre
  RepoFondoOperativo.registrarEntrada({
    condominio_id: cond.id, periodo_fiscal_id: per.id,
    fecha: fmt(hoy), monto: 10000,
    origen_tipo: "AJUSTE", descripcion: "Carga test"
  });
  RepoFondoReserva.registrarEntrada({
    condominio_id: cond.id, periodo_fiscal_id: per.id,
    fecha: fmt(hoy), moneda: "BS", monto: 5000,
    origen_tipo: "AJUSTE", descripcion: "Carga test"
  });

  // Actualizar mora para que la cuota vencida se registre
  ServicioMora.actualizarMoraDelCondominio(cond.id);

  Logger.log("Situaciones creadas");

  // ----------------------------------------------------------
  // 1. DASHBOARD PROPIETARIO (1-A)
  // ----------------------------------------------------------
  Logger.log("\n--- 1. Dashboard propietario 1-A ---");
  const d1 = ServicioDashboard.dashboardPropietario(inm1.id);
  Logger.log("Inmueble: " + d1.inmueble.codigo);
  Logger.log("Cuota mensual: Bs " + d1.cuotaMensual);
  Logger.log("Estado: " + d1.estadoGeneral);
  Logger.log("Meses pagados: " + d1.resumen.mesesPagados);
  Logger.log("Saldo pendiente: Bs " + d1.resumen.saldoPendiente);
  Logger.log("Abono disponible: Bs " + d1.resumen.abonoDisponible);

  // ----------------------------------------------------------
  // 2. DASHBOARD PROPIETARIO (1-B)
  // ----------------------------------------------------------
  Logger.log("\n--- 2. Dashboard propietario 1-B ---");
  const d2 = ServicioDashboard.dashboardPropietario(inm2.id);
  Logger.log("Estado: " + d2.estadoGeneral);
  Logger.log("Meses pendientes: " + d2.resumen.mesesPendientes);
  Logger.log("Saldo pendiente: Bs " + d2.resumen.saldoPendiente);

  // ----------------------------------------------------------
  // 3. DASHBOARD PROPIETARIO (1-C en mora)
  // ----------------------------------------------------------
  Logger.log("\n--- 3. Dashboard propietario 1-C (mora) ---");
  const d3 = ServicioDashboard.dashboardPropietario(inm3.id);
  Logger.log("Estado: " + d3.estadoGeneral + " (esperado: EN_MORA)");
  Logger.log("Meses vencidos: " + d3.resumen.mesesVencidos);
  Logger.log("Saldo: Bs " + d3.resumen.saldoPendiente);
  Logger.log("Interés mora: Bs " + d3.resumen.interesMora);
  Logger.log("Total con mora: Bs " + d3.resumen.saldoConMora);

  // ----------------------------------------------------------
  // 4. DASHBOARD ADMIN
  // ----------------------------------------------------------
  Logger.log("\n--- 4. Dashboard admin ---");
  const admin = ServicioDashboard.dashboardAdmin(cond.id);
  Logger.log("Propietarios totales: " + admin.propietarios.total);
  Logger.log("Al día: " + admin.propietarios.alDia);
  Logger.log("En mora: " + admin.propietarios.enMora);
  Logger.log("Porcentaje al día: " + admin.propietarios.porcentajeAlDia + "%");
  Logger.log("Fondo operativo: Bs " + admin.fondos.operativo);
  Logger.log("Fondo reserva Bs: " + admin.fondos.reservaBs);
  Logger.log("Ingresos del periodo: Bs " + admin.periodoActual.ingresos);
  Logger.log("Egresos del periodo: Bs " + admin.periodoActual.egresos);
  Logger.log("Balance: Bs " + admin.periodoActual.balance);

  Logger.log("Top deudores:");
  admin.topDeudores.forEach(d => {
    Logger.log("  " + d.codigo + " → deuda Bs " + d.deuda);
  });

  Logger.log("Próximos vencimientos:");
  admin.proximosVencimientos.forEach(v => {
    Logger.log("  " + v.inmueble + " | " + v.concepto + " | " + v.fechaVencimiento + " | Bs " + v.saldo);
  });

  // ----------------------------------------------------------
  // 5. SALDO CONSOLIDADO
  // ----------------------------------------------------------
  Logger.log("\n--- 5. Saldo consolidado 1-A ---");
  const sc1 = ServicioDashboard.saldoConsolidado(inm1.id);
  Logger.log("Deuda bruta: Bs " + sc1.deudaBruta);
  Logger.log("Abono: Bs " + sc1.abonoDisponible);
  Logger.log("Deuda neta: Bs " + sc1.deudaNeta);
  Logger.log("¿Al día? " + sc1.estaAlDia);

  Logger.log("\n--- 6. Saldo consolidado 1-C ---");
  const sc3 = ServicioDashboard.saldoConsolidado(inm3.id);
  Logger.log("Deuda bruta: Bs " + sc3.deudaBruta);
  Logger.log("Deuda neta: Bs " + sc3.deudaNeta);
  Logger.log("¿Al día? " + sc3.estaAlDia);

  // ----------------------------------------------------------
  // LIMPIEZA
  // ----------------------------------------------------------
  Logger.log("\n--- Limpieza ---");
  RepoCondominios.eliminar(cond.id);
  Logger.log("Test finalizado");

  Logger.log("\n=== TEST FINALIZADO ===");
}

