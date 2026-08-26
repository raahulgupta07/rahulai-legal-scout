"""
Upload Tools for Agent - Direct functions for API use
"""

import base64
from pathlib import Path

templates_dir = Path("/documents/legal/templates")
knowledge_dir = Path("/documents/legal/knowledge")
templates_dir.mkdir(parents=True, exist_ok=True)
knowledge_dir.mkdir(parents=True, exist_ok=True)


def upload_template(file_content: str, filename: str) -> dict:
    """
    Upload a new document template.

    Args:
        file_content: Base64 encoded file content
        filename: Name of the file including extension

    Returns:
        dict with success status, template name, and detected fields
    """
    try:
        file_bytes = base64.b64decode(file_content)

        file_path = templates_dir / filename
        file_path.write_bytes(file_bytes)

        from scout.tools.template_analyzer import analyze_template

        result = analyze_template(filename)

        from scout.tools.template_analyzer import save_template_knowledge

        if result.get("fields"):
            save_template_knowledge(filename, result["fields"])

        return {
            "success": True,
            "message": f"Template '{filename}' uploaded successfully!",
            "template_name": filename,
            "fields": result.get("fields", []),
            "total_fields": result.get("total_placeholders", 0),
        }
    except Exception as e:
        return {
            "success": False,
            "message": f"Failed to upload template: {e!s}",
            "template_name": filename,
        }


def upload_knowledge(file_content: str, filename: str) -> dict:
    """
    Upload a knowledge data file.

    Args:
        file_content: Base64 encoded file content
        filename: Name of the file including extension

    Returns:
        dict with success status and filename
    """
    try:
        file_bytes = base64.b64decode(file_content)

        file_path = knowledge_dir / filename
        file_path.write_bytes(file_bytes)

        ext = filename.lower().split(".")[-1]
        file_type = "Excel" if ext in ["xlsx", "xls"] else "CSV" if ext == "csv" else "Unknown"

        return {
            "success": True,
            "message": f"Knowledge file '{filename}' uploaded successfully!",
            "filename": filename,
            "file_type": file_type,
            "path": str(file_path),
        }
    except Exception as e:
        return {
            "success": False,
            "message": f"Failed to upload knowledge file: {e!s}",
            "filename": filename,
        }


class UploadTools:
    def __init__(self, host: str = ""):
        self.host = host

    def upload_template(self, file_content: str, filename: str) -> dict:
        return upload_template(file_content, filename)

    def upload_knowledge(self, file_content: str, filename: str) -> dict:
        return upload_knowledge(file_content, filename)


def create_upload_tools(host: str = "") -> dict:
    """Create upload tools for the agent."""
    tools = UploadTools(host=host)
    return {
        "upload_template": tools.upload_template,
        "upload_knowledge": tools.upload_knowledge,
    }
