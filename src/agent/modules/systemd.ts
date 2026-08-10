import {
	collectSystemdSummary,
	collectUnits,
	showUnit,
	systemdAvailable,
	unitAction,
} from "../../collect/systemd.ts";
import { MODULES } from "../../modules/manifest.ts";
import type { UnitActionParams, UnitShowParams } from "../../proto/messages.ts";
import type { NodeModule } from "./mod.ts";
import { requireControl } from "./mod.ts";

/**
 * Units, the system's own view of whether it is healthy, and the detail drawer.
 * A host running openrc or busybox init reports unavailable and the services
 * tab disappears with it.
 */
export const systemdModule: NodeModule = {
	manifest: MODULES.systemd,

	available: () => systemdAvailable(),

	async collect() {
		const units = await collectUnits();
		return { units, systemd: await collectSystemdSummary(units) };
	},

	actions: {
		"unit.show": async (req) =>
			await showUnit(
				String(((req.params ?? {}) as unknown as UnitShowParams).unit ?? ""),
			),

		"unit.action": async (req, ctx) => {
			requireControl(ctx);
			const p = (req.params ?? {}) as unknown as UnitActionParams;
			return await unitAction(p.unit, p.verb);
		},
	},
};
