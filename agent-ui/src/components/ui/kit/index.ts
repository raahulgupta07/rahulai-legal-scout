/**
 * The admin design kit.
 *
 * Everything here is driven by the token layer in globals.css — no component
 * in this directory contains a literal colour. Both themes work by
 * construction, because the tokens flip, not the components.
 *
 *   import { Page, PageHeader, DataTable, Button, Badge } from '@/components/ui/kit'
 */
export { Button, IconButton, ConfirmButton, focusRing } from './Button'
export type { ButtonProps, ButtonVariant, ButtonSize } from './Button'

export { Badge, Label, SeverityStripe } from './Badge'
export type { Tone } from './Badge'

export {
  Field,
  Input,
  Textarea,
  Select,
  TextField,
  SelectField,
  TextareaField,
  Toggle,
  FormGrid,
  controlBase
} from './Field'

export { DataTable } from './DataTable'
export type { Column } from './DataTable'

export { Modal } from './Modal'

export {
  Page,
  PageHeader,
  PageBody,
  Toolbar,
  SearchInput,
  Card,
  StatTile,
  StatRow,
  EmptyState,
  Notice,
  LoadingScreen,
  DetailList,
  Segmented
} from './Layout'

export { assertSuccess, errorMessage, ensureOk, unwrapList, unwrapOne } from './response'

export {
  dateOrNull,
  toDateInput,
  formatDate,
  formatDateTime,
  dateSort,
  formatBytes,
  formatNumber
} from './format'
