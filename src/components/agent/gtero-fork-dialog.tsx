import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";

/** Confirm an explicit Gtero fork (Dialog instead of window.confirm). */
export function GteroForkDialog({
	open,
	onOpenChange,
	onConfirm,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onConfirm: () => void;
}) {
	const { t } = useTranslation(["agent", "common"]);

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent showCloseButton={false} className="sm:max-w-sm">
				<DialogHeader>
					<DialogTitle>{t("tabs.fork")}</DialogTitle>
					<DialogDescription>{t("tabs.forkConfirm")}</DialogDescription>
				</DialogHeader>
				<DialogFooter className="gap-2 sm:gap-0">
					<Button
						type="button"
						variant="outline"
						onClick={() => onOpenChange(false)}
					>
						{t("common:cancel")}
					</Button>
					<Button type="button" onClick={onConfirm}>
						{t("tabs.fork")}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
