"""
Scout Evaluation Suite.

Usage:
    python -m scout.evals.run_evals                    # String matching (default)
    python -m scout.evals.run_evals --llm-grader       # LLM-based grading
    python -m scout.evals.run_evals --check-sources    # Source citation verification
"""

from scout.evals.grader import GradeResult, check_source_citation, grade_response
from scout.evals.test_cases import CATEGORIES, TEST_CASES, TestCase

__all__ = [
    "CATEGORIES",
    "TEST_CASES",
    "GradeResult",
    "TestCase",
    "check_source_citation",
    "grade_response",
]
