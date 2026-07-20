import { type FC } from 'react'

import { Modal, Button } from '@/components/ui/kit'

interface DeleteSessionModalProps {
  isOpen: boolean
  onClose: () => void
  onDelete: () => Promise<void>
  isDeleting: boolean
  /** Named back to the user so they can see which row they armed. */
  sessionTitle?: string
}

/**
 * Deletion is irreversible, so the dialog does two things a bare confirm()
 * cannot: it names the exact conversation being destroyed, and it leaves the
 * safe action as the default focus. The destructive button says what it does
 * rather than saying "OK".
 */
const DeleteSessionModal: FC<DeleteSessionModalProps> = ({
  isOpen,
  onClose,
  onDelete,
  isDeleting,
  sessionTitle
}) => (
  <Modal
    open={isOpen}
    onOpenChange={(open) => {
      if (!open) onClose()
    }}
    size="sm"
    title="Delete this conversation?"
    description="This cannot be undone."
    footer={
      <>
        <Button variant="secondary" autoFocus onClick={onClose} disabled={isDeleting}>
          Keep it
        </Button>
        <Button variant="danger" onClick={onDelete} loading={isDeleting}>
          Delete conversation
        </Button>
      </>
    }
  >
    <div className="space-y-3">
      {sessionTitle && (
        <p className="text-[length:var(--text-sm)] font-medium text-[var(--text)] break-words">
          {sessionTitle}
        </p>
      )}
      <p className="text-[length:var(--text-sm)] text-[var(--text-muted)]">
        The conversation and its full message history are removed permanently.
        Documents already generated from it are not affected.
      </p>
    </div>
  </Modal>
)

export default DeleteSessionModal
