export {
  Button,
  IconButton,
  type ButtonProps,
  type ButtonVariant,
  type IconButtonProps,
} from "./button.tsx";
export {
  Field,
  Input,
  Select,
  Textarea,
  type FieldProps,
  type InputProps,
  type SelectProps,
  type TextareaProps,
} from "./field.tsx";
export {
  Badge,
  CountBadge,
  StateChip,
  type BadgeProps,
  type BadgeTone,
  type CountBadgeProps,
  type StateChipProps,
  type StateChipState,
} from "./badge.tsx";
export {
  BotAvatar,
  botAvatarIdentity,
  botAvatarShapes,
  type BotAvatarEyeStyle,
  type BotAvatarIdentity,
  type BotAvatarProps,
  type BotAvatarShape,
  type BotAvatarSize,
} from "./bot-avatar.tsx";
export { Card, type CardProps, type CardVariant } from "./card.tsx";
export { Separator, type SeparatorProps } from "./separator.tsx";
export { ScrollArea, type ScrollAreaProps } from "./scroll-area.tsx";
export { Tabs, type TabItem, type TabsProps } from "./tabs.tsx";
export {
  SegmentedControl,
  type SegmentedControlOption,
  type SegmentedControlProps,
} from "./segmented-control.tsx";
export { Menu, type MenuItem, type MenuProps } from "./menu.tsx";
export { Dialog, Sheet, type DialogProps } from "./dialog.tsx";
export { Tooltip, type TooltipProps } from "./tooltip.tsx";
export {
  ToastProvider,
  useToast,
  type ToastApi,
  type ToastInput,
  type ToastTone,
} from "./toast.tsx";
export { Skeleton, type SkeletonProps } from "./skeleton.tsx";
export { Icon, iconNames, type IconName, type IconProps } from "./icon.tsx";
export { registerStyleSheet } from "./style-sheet.ts";

export const moduleInfo = {
  name: "@porkbot/ui",
  summary: "Design-system components for the web and desktop surfaces.",
} as const;
export {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarRail,
  SidebarTrigger,
  useSidebar,
  type SidebarContextValue,
  type SidebarMenuButtonProps,
  type SidebarProps,
  type SidebarProviderProps,
  type SidebarState,
} from "./sidebar.tsx";
