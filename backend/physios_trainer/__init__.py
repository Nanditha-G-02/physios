# Copyright 2026 ROBOTIS CO., LTD.
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

"""PHYSIOS training service (host side; formerly pam_trainer of Physical AI Manager v4).

Runs on the robot PC itself (not in Docker) so it can use the operator's conda
environments and GPU.  Standard library only; it never installs or modifies
packages in any environment.
"""

__version__ = '2.0.0'
